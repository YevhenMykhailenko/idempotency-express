import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RedisStore } from "../../src/redis.js";
import { StoreDataError } from "../../src/v3/errors.js";
import { MAX_REDIS_RECORD_BYTES } from "../../src/v3/redis-data.js";
import { connectRedis, isolatedRedis, redisNow, type TestRedis } from "../helpers/redis.js";
import { CONTRACT_KEY, FINGERPRINT, OTHER_FINGERPRINT, response, runStoreContract, start } from "../helpers/store-contract.js";

let client: TestRedis;

beforeAll(async () => { client = await connectRedis(); });
afterAll(async () => { if (client?.isOpen) await client.close(); });
runStoreContract("RedisStore (real Redis)", () => isolatedRedis(client));

describe("Redis wire, TTL integrity, and authoritative clock", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map((close) => close())); });

  function isolated() { const harness = isolatedRedis(client);

    cleanup.push(harness.close);

    return harness; }

  it.each([1, 9_000_000_000_000])("REDIS-03: ignores worker Date.now=%s when claiming and preserving expiry", async (now) => {
    const test = isolated();
    const before = await redisNow(client);

    vi.spyOn(Date, "now").mockReturnValue(now);
    const owner = await start(test.store, CONTRACT_KEY, FINGERPRINT, 10_000);
    const after = await redisNow(client);

    expect(owner.expiresAt).toBeGreaterThanOrEqual(before + 10_000);
    expect(owner.expiresAt).toBeLessThanOrEqual(after + 10_000);
    await test.store.commit(CONTRACT_KEY, response(), owner.reservationId);
    expect(await client.sendCommand(["PEXPIRETIME", test.actualKey(CONTRACT_KEY)])).toBe(owner.expiresAt);
  });

  it("rejects a server-time + TTL overflow before writing", async () => {
    const test = isolated();

    await expect(test.store.begin(CONTRACT_KEY, FINGERPRINT, Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(RangeError);
    expect(await test.store.read(CONTRACT_KEY)).toBeNull();
  });

  it("REDIS-04: round-trips every byte value, empty header arrays and opaque header names", async () => {
    const test = isolated();
    const owner = await start(test.store);
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const cached = response({ body: bytes, headers: JSON.parse('{"__proto__":"plain","x-tags":[],"toJSON":"plain","x-value":"é"}') });

    await test.store.commit(CONTRACT_KEY, cached, owner.reservationId);
    const raw = await client.get(test.actualKey(CONTRACT_KEY));

    expect(raw).toContain(bytes.toString("base64"));
    const entry = await test.store.read(CONTRACT_KEY);

    if (entry?.kind !== "completed") throw new Error("Expected completed entry");

    expect(entry.cached).toEqual(cached);
  });

  it("linearizes concurrent same-owner commits into one canonical first-write-wins result", async () => {
    const test = isolated();
    const owner = await start(test.store);
    const outcomes = await Promise.all([
      test.store.commit(CONTRACT_KEY, response({ body: Buffer.from("first candidate") }), owner.reservationId),
      test.store.commit(CONTRACT_KEY, response({ body: Buffer.from("second candidate") }), owner.reservationId),
    ]);

    expect(outcomes.filter((outcome) => outcome.kind === "committed")).toHaveLength(1);
    const repeated = outcomes.find((outcome) => outcome.kind === "already-committed");

    expect(repeated?.kind).toBe("already-committed");
    if (repeated?.kind !== "already-committed") throw new Error("Expected canonical result");

    expect(repeated.entry).toEqual(await test.store.read(CONTRACT_KEY));
  });

  const corrupt: Array<[string, (raw: string) => string]> = [
    ["unsupported version", (raw) => raw.replace(/^1/, "2")],
    ["invalid framing", () => "not a wire record"],
    ["invalid kind", (raw) => raw.replace("inflight", "unknown")],
    ["invalid fingerprint", (raw) => raw.replace(FINGERPRINT, "A".repeat(64))],
    ["inflight response suffix", (raw) => raw + "partial"],
    ["missing token", (raw) => { const fields = raw.split("\n");

      fields[3] = "";

      return fields.join("\n"); }],
    ["noncanonical deadline", (raw) => { const fields = raw.split("\n");

      fields[4] = "0" + fields[4];

      return fields.join("\n"); }],
    ["oversized record", () => "x".repeat(MAX_REDIS_RECORD_BYTES + 1)],
  ];

  it.each(corrupt)("REDIS-05: fails closed without overwriting %s", async (_name, mutate) => {
    const test = isolated();
    const owner = await start(test.store);
    const key = test.actualKey(CONTRACT_KEY);
    const broken = mutate((await client.get(key))!);

    await client.set(key, broken, { PXAT: owner.expiresAt });
    await expect(test.store.read(CONTRACT_KEY)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.begin(CONTRACT_KEY, OTHER_FINGERPRINT, 1000)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.commit(CONTRACT_KEY, response(), owner.reservationId)).rejects.toBeInstanceOf(StoreDataError);
    expect(await client.get(key)).toBe(broken);
    expect(await client.sendCommand(["PEXPIRETIME", key])).toBe(owner.expiresAt);
  });

  it.each(["missing TTL", "changed deadline", "wrong Redis type"])("REDIS-05: refuses %s without repairing or releasing it", async (kind) => {
    const test = isolated();
    const owner = await start(test.store);
    const key = test.actualKey(CONTRACT_KEY);

    if (kind === "missing TTL") await client.persist(key);
    else if (kind === "changed deadline") await client.pExpireAt(key, owner.expiresAt + 1);
    else { await client.del(key); await client.hSet(key, "version", "foreign"); await client.pExpireAt(key, owner.expiresAt); }

    const expiry = await client.sendCommand(["PEXPIRETIME", key]);

    await expect(test.store.read(CONTRACT_KEY)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.begin(CONTRACT_KEY, FINGERPRINT, 1000)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.commit(CONTRACT_KEY, response(), owner.reservationId)).rejects.toBeInstanceOf(StoreDataError);
    expect(await client.sendCommand(["PEXPIRETIME", key])).toBe(expiry);
    expect(await client.exists(key)).toBe(1);
    if (kind === "wrong Redis type") {
      expect(await client.type(key)).toBe("hash");
      expect(await client.hGet(key, "version")).toBe("foreign");
    }
  });

  it.each([
    ["bad JSON", (): string => "{"],
    ["duplicate field", (): string => '{"status":200,"status":201}'],
    ["bad base64", () => JSON.stringify({ ...response(), body: "!not-base64!" })],
    ["noncanonical base64 bits", () => JSON.stringify({ ...response(), body: "Zh==" })],
    ["wrong cached fingerprint", () => JSON.stringify({ ...response({ fingerprint: OTHER_FINGERPRINT }), body: "" })],
    ["extra cached field", () => JSON.stringify({ ...response(), body: "", secret: true })],
    ["invalid status", () => JSON.stringify({ ...response({ status: 600 }), body: "" })],
    ["header injection", () => JSON.stringify({ ...response({ headers: { x: "bad\r\n" } }), body: "" })],
  ] as const)("REDIS-05: validates a completed %s before conflict/replay/already-committed", async (_name, makePayload) => {
    const test = isolated();
    const owner = await start(test.store);

    await test.store.commit(CONTRACT_KEY, response(), owner.reservationId);
    const key = test.actualKey(CONTRACT_KEY);
    const fields = (await client.get(key))!.split("\n");
    const broken = fields.slice(0, 5).join("\n") + "\n" + makePayload();

    await client.set(key, broken, { KEEPTTL: true });
    await expect(test.store.read(CONTRACT_KEY)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.begin(CONTRACT_KEY, FINGERPRINT, 1000)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.begin(CONTRACT_KEY, OTHER_FINGERPRINT, 1000)).rejects.toBeInstanceOf(StoreDataError);
    await expect(test.store.commit(CONTRACT_KEY, response(), owner.reservationId)).rejects.toBeInstanceOf(StoreDataError);
    expect(await client.get(key)).toBe(broken);
  });

  it("requires no driver-owned connect/disconnect and accepts a real node-redis client structurally", () => {
    expect(new RedisStore({ client }).protocolVersion).toBe(3);
  });
});
