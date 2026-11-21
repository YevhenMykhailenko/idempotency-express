import { describe, it, expect, vi, afterEach } from "vitest";

import { MemoryStore } from "../src/memory-store.js";
import { FINGERPRINT, OTHER_FINGERPRINT, response, start } from "./helpers/store-contract.js";
import { buildStorageKey } from "../src/v3/key.js";

const key = buildStorageKey("public-ttl", "user", "key");

describe("public MemoryStore TTL and expiry", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("replays within TTL and expires after TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new MemoryStore();
    const owner = await start(store, key, FINGERPRINT, 1_000);

    await store.commit(key, response(), owner.reservationId);
    clock.mockReturnValue(1_500);
    expect((await store.begin(key, FINGERPRINT, 1_000)).kind).toBe("replay");
    clock.mockReturnValue(2_200);
    expect((await store.begin(key, FINGERPRINT, 1_000)).kind).toBe("started");
  });

  it("conflicts for another fingerprint within TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const store = new MemoryStore();
    const owner = await start(store, key, FINGERPRINT, 1_000);

    await store.commit(key, response(), owner.reservationId);
    clock.mockReturnValue(10_500);
    expect(await store.begin(key, OTHER_FINGERPRINT, 1_000)).toEqual({ kind: "conflict" });
  });

  it("does not create a completed record without an active reservation", async () => {
    const store = new MemoryStore();

    expect(await store.commit(key, response(), "unknown-owner")).toEqual({ kind: "reservation-lost" });
    expect((await store.begin(key, FINGERPRINT, 1_000)).kind).toBe("started");
  });

  it("does not let an old commit overwrite a completed replacement", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new MemoryStore();
    const old = await start(store, key, FINGERPRINT, 100);

    clock.mockReturnValue(1_101);
    const current = await start(store, key, OTHER_FINGERPRINT, 1_000);

    await store.commit(key, response({ fingerprint: OTHER_FINGERPRINT, body: Buffer.from("new") }), current.reservationId);
    expect(await store.commit(key, response(), old.reservationId)).toEqual({ kind: "reservation-lost" });
    const entry = await store.read(key);

    if (entry?.kind !== "completed") throw new Error("Expected completed entry");

    expect(entry.cached.body.toString()).toBe("new");
  });

  it("does not let an expired owner modify a replacement with the same fingerprint", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = new MemoryStore();
    const old = await start(store, key, FINGERPRINT, 100);

    clock.mockReturnValue(1_101);
    const current = await start(store, key, FINGERPRINT, 1_000);

    expect(await store.commit(key, response(), old.reservationId)).toEqual({ kind: "reservation-lost" });
    expect("abort" in store).toBe(false);
    expect((await store.read(key))?.reservationId).toBe(current.reservationId);
    await store.commit(key, response({ body: Buffer.from("new") }), current.reservationId);
    const entry = await store.read(key);

    if (entry?.kind !== "completed") throw new Error("Expected completed entry");

    expect(entry.cached.body.toString()).toBe("new");
  });
});
