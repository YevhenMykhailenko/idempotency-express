import { describe, it, expect } from "vitest";

import { MemoryStore } from "../src/memory-store.js";
import { FINGERPRINT, OTHER_FINGERPRINT, response, start } from "./helpers/store-contract.js";
import { buildStorageKey } from "../src/v3/key.js";

describe("public MemoryStore", () => {
  it("starts then replays", async () => {
    const store = new MemoryStore();
    const key = buildStorageKey("public-store", "user", "k1");
    const owner = await start(store, key);

    await store.commit(key, response(), owner.reservationId);
    expect((await store.begin(key, FINGERPRINT, 1_000)).kind).toBe("replay");
  });

  it("conflicts on a different fingerprint", async () => {
    const store = new MemoryStore();
    const key = buildStorageKey("public-store", "user", "k2");

    await start(store, key);
    expect(await store.begin(key, OTHER_FINGERPRINT, 1_000)).toEqual({ kind: "conflict" });
  });

  it("is inflight for the same fingerprint", async () => {
    const store = new MemoryStore();
    const key = buildStorageKey("public-store", "user", "k3");
    const owner = await start(store, key);

    expect(await store.begin(key, FINGERPRINT, 1_000)).toEqual({
      kind: "inflight", reservationId: owner.reservationId, expiresAt: owner.expiresAt,
    });
  });
});
