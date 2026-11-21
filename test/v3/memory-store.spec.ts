import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreCapacityError, StoreDataError } from "../../src/v3/errors.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { DEFAULT_MEMORY_MAX_ENTRIES } from "../../src/v3/limits.js";
import { MemoryStore } from "../../src/v3/memory-store.js";
import type { MemoryStoreOptions } from "../../src/v3/types.js";
import {
  CONTRACT_KEY,
  FINGERPRINT,
  OTHER_FINGERPRINT,
  response,
  runStoreContract,
  start,
} from "../helpers/store-contract.js";

runStoreContract("MemoryStore", () => {
  let now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);

  return {
    store: new MemoryStore(),
    advanceTo(deadline) {
      if (deadline < now) throw new Error("The test clock must not go backwards");

      now = deadline;
    },
    close: () => { clock.mockRestore(); },
  };
});

describe("MemoryStore v3 — clock and bounded capacity", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it.each([false, true])("STORE-04: enforces the exact E-1/E/E+1 boundary (completed=%s)", async (completed) => {
    const store = new MemoryStore();
    const owner = await start(store, CONTRACT_KEY, FINGERPRINT, 1_000);

    expect(owner.expiresAt).toBe(now + 1_000);
    if (completed) await store.commit(CONTRACT_KEY, response(), owner.reservationId);

    now = owner.expiresAt - 1;
    expect((await store.read(CONTRACT_KEY))?.reservationId).toBe(owner.reservationId);
    const duplicate = await store.begin(CONTRACT_KEY, FINGERPRINT, 10_000);

    expect(duplicate.kind).toBe(completed ? "replay" : "inflight");
    expect((await store.read(CONTRACT_KEY))?.expiresAt).toBe(owner.expiresAt);

    now = owner.expiresAt;
    expect(await store.read(CONTRACT_KEY)).toBeNull();
    expect(await store.commit(CONTRACT_KEY, response(), owner.reservationId)).toEqual({ kind: "reservation-lost" });
    now += 1;
    const replacement = await start(store);

    expect(replacement.reservationId).not.toBe(owner.reservationId);
  });

  it("STORE-05: a commit at E-1 preserves the deadline and expires at E", async () => {
    const store = new MemoryStore();
    const owner = await start(store, CONTRACT_KEY, FINGERPRINT, 1_000);

    now = owner.expiresAt - 1;
    expect(await store.commit(CONTRACT_KEY, response(), owner.reservationId)).toEqual({ kind: "committed" });
    expect((await store.read(CONTRACT_KEY))?.expiresAt).toBe(owner.expiresAt);
    now = owner.expiresAt;
    expect(await store.read(CONTRACT_KEY)).toBeNull();
  });

  it("STORE-12: rejects a new key without evicting live inflight or completed entries", async () => {
    const store = new MemoryStore({ maxEntries: 2 });
    const secondKey = buildStorageKey("capacity", "user", "second");
    const thirdKey = buildStorageKey("capacity", "user", "third");
    const owner = await start(store, CONTRACT_KEY, FINGERPRINT, 1_000);

    await start(store, secondKey, FINGERPRINT, 10_000);
    await store.commit(CONTRACT_KEY, response(), owner.reservationId);
    const completed = await store.read(CONTRACT_KEY);
    const inflight = await store.read(secondKey);

    await expect(store.begin(thirdKey, FINGERPRINT, 1_000)).rejects.toBeInstanceOf(StoreCapacityError);
    expect(await store.read(thirdKey)).toBeNull();
    expect(await store.read(CONTRACT_KEY)).toEqual(completed);
    expect(await store.read(secondKey)).toEqual(inflight);

    now = owner.expiresAt;
    await start(store, thirdKey);
    expect(await store.read(CONTRACT_KEY)).toBeNull();
    expect(await store.read(secondKey)).toEqual(inflight);
  });

  it("STORE-13: resolves existing keys normally at full capacity", async () => {
    const store = new MemoryStore({ maxEntries: 1 });
    const owner = await start(store);

    expect(await store.begin(CONTRACT_KEY, FINGERPRINT, 60_000)).toEqual({
      kind: "inflight", reservationId: owner.reservationId, expiresAt: owner.expiresAt,
    });
    expect(await store.begin(CONTRACT_KEY, OTHER_FINGERPRINT, 60_000)).toEqual({ kind: "conflict" });
    await store.commit(CONTRACT_KEY, response(), owner.reservationId);
    expect((await store.begin(CONTRACT_KEY, FINGERPRINT, 60_000)).kind).toBe("replay");
    expect(await store.begin(CONTRACT_KEY, OTHER_FINGERPRINT, 60_000)).toEqual({ kind: "conflict" });
  });

  it("uses the default limit of 256 reservations rather than an unbounded cache", async () => {
    const store = new MemoryStore();

    for (let i = 0; i < DEFAULT_MEMORY_MAX_ENTRIES; i++) {
      await start(store, buildStorageKey("capacity", "user", `key-${i}`));
    }

    await expect(store.begin(CONTRACT_KEY, FINGERPRINT, 60_000)).rejects.toBeInstanceOf(StoreCapacityError);
  });

  it("allows zero-valued diagnostic createdAt without treating it as absent", async () => {
    const store = new MemoryStore();
    const owner = await start(store);

    await store.commit(CONTRACT_KEY, response({ createdAt: 0 }), owner.reservationId);
    const entry = await store.read(CONTRACT_KEY);

    if (entry?.kind !== "completed") throw new Error("Expected completed entry");

    expect(entry.cached.createdAt).toBe(0);
  });

  it("rejects deadline overflow before claiming, while allowing an exact safe boundary", async () => {
    const store = new MemoryStore();

    now = Number.MAX_SAFE_INTEGER - 10;
    await expect(store.begin(CONTRACT_KEY, FINGERPRINT, 11)).rejects.toBeInstanceOf(RangeError);
    expect(await store.read(CONTRACT_KEY)).toBeNull();
    const owner = await start(store, CONTRACT_KEY, FINGERPRINT, 10);

    expect(owner.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    now = Number.MAX_SAFE_INTEGER;
    expect(await store.read(CONTRACT_KEY)).toBeNull();
  });

  it.each([Number.NaN, Infinity, -1, 0.5])("rejects an invalid store clock %j without changing a live entry", async (invalidNow) => {
    const store = new MemoryStore();
    const owner = await start(store);
    const before = await store.read(CONTRACT_KEY);

    now = invalidNow;
    await expect(store.read(CONTRACT_KEY)).rejects.toBeInstanceOf(StoreDataError);
    await expect(store.begin(CONTRACT_KEY, FINGERPRINT, 1_000)).rejects.toBeInstanceOf(StoreDataError);
    await expect(store.commit(CONTRACT_KEY, response(), owner.reservationId)).rejects.toBeInstanceOf(StoreDataError);
    now = 1_000_000;
    expect(await store.read(CONTRACT_KEY)).toEqual(before);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "2"])("CFG-02: rejects invalid maxEntries %j", (maxEntries) => {
    expect(() => new MemoryStore({ maxEntries: maxEntries as number })).toThrow(RangeError);
  });

  it.each([null, [], new Date(), "options"])("CFG-01: rejects malformed options %j", (options) => {
    expect(() => new MemoryStore(options as MemoryStoreOptions)).toThrow(TypeError);
  });

  it("accepts null-prototype configuration objects", () => {
    expect(new MemoryStore(Object.assign(Object.create(null), { maxEntries: 1 })).protocolVersion).toBe(3);
  });
});
