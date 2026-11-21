import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoreDataError } from "../../src/v3/errors.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { MAX_CACHED_BODY_BYTES, MAX_CACHED_HEADER_BYTES } from "../../src/v3/limits.js";
import type { BeginResult, CachedResponse, Store } from "../../src/v3/types.js";

export const FINGERPRINT = "a".repeat(64);
export const OTHER_FINGERPRINT = "b".repeat(64);
export const CONTRACT_KEY = buildStorageKey("store-contract", "user", "key");
const TTL = 60_000;

export type StoreContractHarness = {
  store: Store;
  /** Real backends may choose a longer expiry window for integration-test stability. */
  expiryTtlMs?: number;
  /** Advance the authoritative clock to at least this deadline; never mutate the record. */
  advanceTo: (deadlineMs: number) => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export function response(overrides: Partial<CachedResponse> = {}): CachedResponse {
  return {
    status: 201,
    body: Buffer.from("original response"),
    headers: { "content-type": "text/plain", "x-tags": ["first", "second"] },
    fingerprint: FINGERPRINT,
    createdAt: 1_000,
    ...overrides,
  };
}

export async function start(
  store: Store,
  key = CONTRACT_KEY,
  fingerprint = FINGERPRINT,
  ttlMs = TTL,
): Promise<Extract<BeginResult, { kind: "started" }>> {
  const result = await store.begin(key, fingerprint, ttlMs);

  expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error("Expected a new reservation");

  return result;
}

const invalidResponses: Array<[string, () => unknown]> = [
  ["null", () => null],
  ["array", () => []],
  ["class instance", () => Object.assign(new Date(), response())],
  ["custom prototype", () => Object.assign(Object.create({ inherited: true }), response())],
  ["missing field", () => { const partial: Partial<CachedResponse> = response();

    delete partial.createdAt;

    return partial; }],
  ["extra field", () => ({ ...response(), secret: "not part of the protocol" })],
  ["symbol field", () => ({ ...response(), [Symbol("extra")]: true })],
  ["accessor field", () => Object.defineProperty(response(), "status", {
    enumerable: true, get() { throw new Error("Must not invoke a response getter"); },
  })],
  ["non-enumerable field", () => Object.defineProperty(response(), "status", { enumerable: false })],
  ["status below range", () => response({ status: 199 })],
  ["status above range", () => response({ status: 600 })],
  ["fractional status", () => response({ status: 201.5 })],
  ["NaN status", () => response({ status: Number.NaN })],
  ["string status", () => ({ ...response(), status: "201" })],
  ["string body", () => ({ ...response(), body: "not bytes" })],
  ["Uint8Array body", () => ({ ...response(), body: new Uint8Array([1, 2]) })],
  ["oversized body", () => response({ body: Buffer.alloc(MAX_CACHED_BODY_BYTES + 1) })],
  ["nonempty 204", () => response({ status: 204 })],
  ["nonempty 205", () => response({ status: 205 })],
  ["nonempty 304", () => response({ status: 304 })],
  ["short fingerprint", () => response({ fingerprint: "short" })],
  ["uppercase fingerprint", () => response({ fingerprint: "A".repeat(64) })],
  ["non-hex fingerprint", () => response({ fingerprint: "g".repeat(64) })],
  ["negative timestamp", () => response({ createdAt: -1 })],
  ["fractional timestamp", () => response({ createdAt: 1.5 })],
  ["infinite timestamp", () => response({ createdAt: Infinity })],
  ["unsafe timestamp", () => response({ createdAt: Number.MAX_SAFE_INTEGER + 1 })],
  ["null headers", () => ({ ...response(), headers: null })],
  ["array headers", () => ({ ...response(), headers: [] })],
  ["date headers", () => ({ ...response(), headers: new Date() })],
  ["symbol header", () => ({ ...response(), headers: { [Symbol("header")]: "value" } })],
  ["invalid header name", () => response({ headers: { "bad header": "value" } })],
  ["duplicate header case", () => response({ headers: { "X-Tag": "a", "x-tag": "b" } })],
  ["CRLF header injection", () => response({ headers: { "x-tag": "value\r\ninjected: yes" } })],
  ["non-string header", () => ({ ...response(), headers: { "x-tag": 42 } })],
  ["non-string array item", () => ({ ...response(), headers: { "x-tag": ["valid", 42] } })],
  ["sparse header array", () => response({ headers: { "x-tag": new Array<string>(2) } })],
  ["header array with extras", () => response({ headers: { "x-tag": Object.assign(["value"], { extra: true }) } })],
  ["oversized header array", () => response({ headers: { "x-tag": Array<string>(10_000).fill("") } })],
  ["accessor header", () => ({ ...response(), headers: Object.defineProperty({}, "x-tag", {
    enumerable: true, get() { throw new Error("Must not invoke a header getter"); },
  }) })],
  ["accessor array item", () => response({ headers: { "x-tag": Object.defineProperty(["value"], "0", {
    enumerable: true, get() { throw new Error("Must not invoke an array getter"); },
  }) } })],
  ["oversized headers", () => response({ headers: { x: "a".repeat(MAX_CACHED_HEADER_BYTES) } })],
];

/** Backend-neutral suite. Redis supplies its own clock/cleanup harness in stage 4. */
export function runStoreContract(
  name: string,
  createHarness: () => StoreContractHarness | Promise<StoreContractHarness>,
): void {
  describe(`${name} — Store v3 contract`, () => {
    let harness: StoreContractHarness;
    let store: Store;

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
    });

    afterEach(async () => {
      await harness?.close?.();
    });

    it("exposes protocol 3 without a release/get API", () => {
      expect(store.protocolVersion).toBe(3);
      for (const method of ["abort", "release", "get"]) expect(method in store).toBe(false);
    });

    it("reads a missing key without creating a reservation", async () => {
      expect(await store.read(CONTRACT_KEY)).toBeNull();
      expect(await store.read(CONTRACT_KEY)).toBeNull();
      await start(store);
    });

    it("STORE-01: allows exactly one of 100 concurrent claims", async () => {
      let open!: () => void;
      const barrier = new Promise<void>((resolve) => { open = resolve; });
      const pending = Array.from({ length: 100 }, async () => {
        await barrier;

        return store.begin(CONTRACT_KEY, FINGERPRINT, TTL);
      });

      open();
      const results = await Promise.all(pending);
      const [winner] = results.filter((result) => result.kind === "started");

      expect(winner).toBeDefined();
      expect(results.filter((result) => result.kind === "started")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "inflight")).toHaveLength(99);
      for (const result of results) {
        if (result.kind !== "started" && result.kind !== "inflight") throw new Error("Unexpected claim result");

        expect(result.reservationId).toBe(winner.reservationId);
        expect(result.expiresAt).toBe(winner.expiresAt);
      }

      expect(winner.reservationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    });

    it("uses independent ownership tokens for different keys", async () => {
      const keys = Array.from({ length: 20 }, (_, i) => buildStorageKey("store-contract", "user", `key-${i}`));
      const claims = await Promise.all(keys.map((key) => start(store, key)));

      expect(new Set(claims.map((claim) => claim.reservationId)).size).toBe(keys.length);
    });

    it.each([false, true])("STORE-02: conflicts without changing an existing record (completed=%s)", async (completed) => {
      const owner = await start(store);

      if (completed) await store.commit(CONTRACT_KEY, response(), owner.reservationId);

      const before = await store.read(CONTRACT_KEY);

      expect(await store.begin(CONTRACT_KEY, OTHER_FINGERPRINT, TTL * 2)).toEqual({ kind: "conflict" });
      expect(await store.read(CONTRACT_KEY)).toEqual(before);
    });

    it("STORE-03: commits once and returns the complete canonical replay entry", async () => {
      const owner = await start(store);
      const cached = response();

      expect(await store.commit(CONTRACT_KEY, cached, owner.reservationId)).toEqual({ kind: "committed" });
      const expected = {
        kind: "completed", fingerprint: FINGERPRINT,
        reservationId: owner.reservationId, expiresAt: owner.expiresAt, cached,
      };

      expect(await store.read(CONTRACT_KEY)).toEqual(expected);
      expect(await store.begin(CONTRACT_KEY, FINGERPRINT, TTL * 2)).toEqual({ kind: "replay", entry: expected });
    });

    it.each([200, 299, 301, 400, 429, 500, 599])("retains a completed %i response, including errors", async (status) => {
      const owner = await start(store);

      await store.commit(CONTRACT_KEY, response({ status }), owner.reservationId);
      const replay = await store.begin(CONTRACT_KEY, FINGERPRINT, TTL);

      expect(replay.kind).toBe("replay");
      if (replay.kind !== "replay") throw new Error("Expected replay");

      expect(replay.entry.cached.status).toBe(status);
    });

    it.each([204, 205, 304])("retains an empty %i response", async (status) => {
      const owner = await start(store);

      await store.commit(CONTRACT_KEY, response({ status, body: Buffer.alloc(0), headers: {} }), owner.reservationId);
      const entry = await store.read(CONTRACT_KEY);

      expect(entry?.kind).toBe("completed");
      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(entry.cached.body.length).toBe(0);
      expect(entry.cached.headers).toEqual({});
    });

    it.each([false, true])("STORE-04: expires records without reviving a late commit (completed=%s)", async (completed) => {
      const owner = await start(store, CONTRACT_KEY, FINGERPRINT, harness.expiryTtlMs ?? 1_000);

      if (completed) await store.commit(CONTRACT_KEY, response(), owner.reservationId);

      await harness.advanceTo(owner.expiresAt);
      expect(await store.read(CONTRACT_KEY)).toBeNull();
      expect(await store.commit(CONTRACT_KEY, response(), owner.reservationId)).toEqual({ kind: "reservation-lost" });
      expect(await store.read(CONTRACT_KEY)).toBeNull();
      const replacement = await start(store);

      expect(replacement.reservationId).not.toBe(owner.reservationId);
    });

    it("STORE-05: preserves the original deadline on every duplicate/read/commit", async () => {
      const owner = await start(store, CONTRACT_KEY, FINGERPRINT, harness.expiryTtlMs ?? 1_000);

      expect(await store.begin(CONTRACT_KEY, FINGERPRINT, TTL * 10)).toEqual({
        kind: "inflight", reservationId: owner.reservationId, expiresAt: owner.expiresAt,
      });
      expect((await store.read(CONTRACT_KEY))?.expiresAt).toBe(owner.expiresAt);
      await store.commit(CONTRACT_KEY, response(), owner.reservationId);
      expect((await store.read(CONTRACT_KEY))?.expiresAt).toBe(owner.expiresAt);
      const replay = await store.begin(CONTRACT_KEY, FINGERPRINT, TTL * 10);

      if (replay.kind !== "replay") throw new Error("Expected replay");

      expect(replay.entry.expiresAt).toBe(owner.expiresAt);
      await harness.advanceTo(owner.expiresAt);
      expect(await store.read(CONTRACT_KEY)).toBeNull();
    });

    it("STORE-06: an expired owner cannot commit over the same-fingerprint replacement", async () => {
      const old = await start(store, CONTRACT_KEY, FINGERPRINT, harness.expiryTtlMs ?? 1_000);

      await harness.advanceTo(old.expiresAt);
      const current = await start(store);
      const before = await store.read(CONTRACT_KEY);

      expect(await store.commit(CONTRACT_KEY, response(), old.reservationId)).toEqual({ kind: "reservation-lost" });
      expect(await store.read(CONTRACT_KEY)).toEqual(before);
      expect(await store.commit(CONTRACT_KEY, response(), current.reservationId)).toEqual({ kind: "committed" });
    });

    it("STORE-07: commits without an active reservation never create entries", async () => {
      expect(await store.commit(CONTRACT_KEY, response(), "unknown-owner")).toEqual({ kind: "reservation-lost" });
      expect(await store.read(CONTRACT_KEY)).toBeNull();
    });

    it("STORE-07: a wrong token or fingerprint cannot change a live reservation", async () => {
      const owner = await start(store);
      const before = await store.read(CONTRACT_KEY);

      expect(await store.commit(CONTRACT_KEY, response(), "wrong-owner")).toEqual({ kind: "reservation-lost" });
      expect(await store.commit(CONTRACT_KEY, response({ fingerprint: OTHER_FINGERPRINT }), owner.reservationId))
        .toEqual({ kind: "reservation-lost" });
      expect(await store.read(CONTRACT_KEY)).toEqual(before);
    });

    it("STORE-08: the first committed result wins even for the same owner", async () => {
      const owner = await start(store);

      await store.commit(CONTRACT_KEY, response(), owner.reservationId);
      const canonical = await store.read(CONTRACT_KEY);
      const retry = await store.commit(CONTRACT_KEY, response({ body: Buffer.from("different"), status: 500 }), owner.reservationId);

      expect(retry).toEqual({ kind: "already-committed", entry: canonical });
      expect(await store.read(CONTRACT_KEY)).toEqual(canonical);
    });

    it("STORE-09: an older owner cannot overwrite a completed replacement", async () => {
      const old = await start(store, CONTRACT_KEY, FINGERPRINT, harness.expiryTtlMs ?? 1_000);

      await harness.advanceTo(old.expiresAt);
      const current = await start(store);

      await store.commit(CONTRACT_KEY, response(), current.reservationId);
      const canonical = await store.read(CONTRACT_KEY);

      expect(await store.commit(CONTRACT_KEY, response({ body: Buffer.from("late") }), old.reservationId))
        .toEqual({ kind: "reservation-lost" });
      expect(await store.read(CONTRACT_KEY)).toEqual(canonical);
    });

    it("STORE-10: snapshots commit input before the caller can mutate it", async () => {
      const owner = await start(store);
      const cached = response();
      const pending = store.commit(CONTRACT_KEY, cached, owner.reservationId);

      cached.body.fill(0);
      (cached.headers["x-tags"] as string[])[0] = "changed";
      cached.headers.extra = "changed";
      cached.status = 500;
      cached.fingerprint = OTHER_FINGERPRINT;
      cached.createdAt = 0;
      await pending;
      const entry = await store.read(CONTRACT_KEY);

      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(entry.cached).toEqual(response());
    });

    it("STORE-10: begin and read return detached reservation metadata", async () => {
      const owner = await start(store);
      const expected = await store.read(CONTRACT_KEY);

      owner.reservationId = "changed";
      owner.expiresAt = 0;
      const inflight = await store.begin(CONTRACT_KEY, FINGERPRINT, TTL);

      if (inflight.kind !== "inflight") throw new Error("Expected inflight entry");

      inflight.reservationId = "changed-again";
      inflight.expiresAt = 0;
      const read = await store.read(CONTRACT_KEY);

      if (!read) throw new Error("Missing entry");

      read.reservationId = "changed-read";
      read.fingerprint = OTHER_FINGERPRINT;
      read.expiresAt = 0;
      expect(await store.read(CONTRACT_KEY)).toEqual(expected);
    });

    it("STORE-10: caller mutation during a repeated commit cannot change its canonical result or fingerprint comparison", async () => {
      const owner = await start(store);

      await store.commit(CONTRACT_KEY, response(), owner.reservationId);
      const canonical = await store.read(CONTRACT_KEY);
      const candidate = response();
      const pending = store.commit(CONTRACT_KEY, candidate, owner.reservationId);

      candidate.fingerprint = OTHER_FINGERPRINT;
      candidate.body.fill(0);
      expect(await pending).toEqual({ kind: "already-committed", entry: canonical });
      expect(await store.read(CONTRACT_KEY)).toEqual(canonical);
    });

    it("STORE-10: every completed read/replay/repeated commit returns a detached snapshot", async () => {
      const owner = await start(store);

      await store.commit(CONTRACT_KEY, response(), owner.reservationId);
      const canonical = await store.read(CONTRACT_KEY);
      const read = await store.read(CONTRACT_KEY);
      const replay = await store.begin(CONTRACT_KEY, FINGERPRINT, TTL);
      const repeat = await store.commit(CONTRACT_KEY, response(), owner.reservationId);

      if (read?.kind !== "completed" || replay.kind !== "replay" || repeat.kind !== "already-committed") {
        throw new Error("Expected completed snapshots");
      }

      for (const entry of [read, replay.entry, repeat.entry]) {
        entry.expiresAt = 0;
        entry.reservationId = "changed";
        entry.cached.body.fill(0);
        entry.cached.status = 500;
        entry.cached.fingerprint = OTHER_FINGERPRINT;
        (entry.cached.headers["x-tags"] as string[])[0] = "changed";
      }

      expect(await store.read(CONTRACT_KEY)).toEqual(canonical);
    });

    describe.each([false, true])("STORE-11: invalid commit data (completed=%s)", (completed) => {
      it.each(invalidResponses)("rejects %s without modifying the entry", async (_name, createInvalid) => {
        const owner = await start(store);

        if (completed) await store.commit(CONTRACT_KEY, response(), owner.reservationId);

        const before = await store.read(CONTRACT_KEY);

        await expect(store.commit(CONTRACT_KEY, createInvalid() as CachedResponse, owner.reservationId))
          .rejects.toBeInstanceOf(StoreDataError);
        expect(await store.read(CONTRACT_KEY)).toEqual(before);
      });
    });

    it.each([undefined, null, "", "with space", "\n", "x".repeat(129), 42])("rejects malformed reservation ID %j without mutation", async (token) => {
      await start(store);
      const before = await store.read(CONTRACT_KEY);

      await expect(store.commit(CONTRACT_KEY, response(), token as string)).rejects.toBeInstanceOf(StoreDataError);
      expect(await store.read(CONTRACT_KEY)).toEqual(before);
    });

    it.each(["", "short", "A".repeat(64), "a".repeat(64) + "\n", null, 42])("rejects malformed begin fingerprint %j", async (fingerprint) => {
      await expect(store.begin(CONTRACT_KEY, fingerprint as string, TTL)).rejects.toBeInstanceOf(StoreDataError);
      expect(await store.read(CONTRACT_KEY)).toBeNull();
    });

    it.each(["", "key", "idem:v3:" + "A".repeat(64), CONTRACT_KEY + "\n", null, 42])("rejects malformed physical key %j on every method", async (key) => {
      const owner = await start(store);
      const before = await store.read(CONTRACT_KEY);

      await expect(store.begin(key as string, FINGERPRINT, TTL)).rejects.toBeInstanceOf(StoreDataError);
      await expect(store.read(key as string)).rejects.toBeInstanceOf(StoreDataError);
      await expect(store.commit(key as string, response(), owner.reservationId)).rejects.toBeInstanceOf(StoreDataError);
      expect(await store.read(CONTRACT_KEY)).toEqual(before);
    });

    it.each([0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "1000"])("rejects invalid ttlMs %j before claim", async (ttlMs) => {
      await expect(store.begin(CONTRACT_KEY, FINGERPRINT, ttlMs as number)).rejects.toBeInstanceOf(RangeError);
      expect(await store.read(CONTRACT_KEY)).toBeNull();
    });

    it("accepts a body at the hard byte limit without truncation", async () => {
      const owner = await start(store);
      const body = Buffer.alloc(MAX_CACHED_BODY_BYTES, 0xfe);

      await store.commit(CONTRACT_KEY, response({ body }), owner.reservationId);
      const entry = await store.read(CONTRACT_KEY);

      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(entry.cached.body.equals(body)).toBe(true);
    });

    it.each(["a", "é", "\\"])("counts exact serialized UTF-8 header bytes for %j", async (character) => {
      const owner = await start(store);
      const overhead = Buffer.byteLength(JSON.stringify({ x: "" }));
      const encodedBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
      const count = Math.floor((MAX_CACHED_HEADER_BYTES - overhead) / encodedBytes);
      const value = character.repeat(count) + "a".repeat((MAX_CACHED_HEADER_BYTES - overhead) % encodedBytes);
      const headers = { x: value };

      expect(Buffer.byteLength(JSON.stringify(headers))).toBe(MAX_CACHED_HEADER_BYTES);
      await store.commit(CONTRACT_KEY, response({ headers }), owner.reservationId);
      const entry = await store.read(CONTRACT_KEY);

      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(entry.cached.headers).toEqual(headers);
      await expect(store.commit(CONTRACT_KEY, response({ headers: { x: value + "a" } }), owner.reservationId))
        .rejects.toBeInstanceOf(StoreDataError);
    });

    it("counts header array brackets, commas and multiple field names in the byte budget", async () => {
      const owner = await start(store);
      const overhead = Buffer.byteLength(JSON.stringify({ x: ["", ""], y: "" }));
      const headers = { x: ["a".repeat(MAX_CACHED_HEADER_BYTES - overhead), ""], y: "" };

      expect(Buffer.byteLength(JSON.stringify(headers))).toBe(MAX_CACHED_HEADER_BYTES);
      await store.commit(CONTRACT_KEY, response({ headers }), owner.reservationId);
      const entry = await store.read(CONTRACT_KEY);

      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(entry.cached.headers).toEqual(headers);
      await expect(store.commit(CONTRACT_KEY, response({ headers: { ...headers, z: "" } }), owner.reservationId))
        .rejects.toBeInstanceOf(StoreDataError);
    });

    it("snapshots null-prototype headers and __proto__ as an ordinary header", async () => {
      const owner = await start(store);
      const headers = Object.assign(Object.create(null), JSON.parse('{"__proto__":"value","x-tags":[],"toJSON":"text"}'));

      await store.commit(CONTRACT_KEY, response({ headers }), owner.reservationId);
      const entry = await store.read(CONTRACT_KEY);

      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(Object.hasOwn(entry.cached.headers, "__proto__")).toBe(true);
      expect(entry.cached.headers["__proto__"]).toBe("value");
      expect(entry.cached.headers["x-tags"]).toEqual([]);
      expect(entry.cached.headers.toJSON).toBe("text");
      const prototype: unknown = Object.getPrototypeOf(entry.cached.headers);

      expect(prototype === null || prototype === Object.prototype).toBe(true);
    });
  });
}
