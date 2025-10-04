import { describe, it, expect } from "vitest";

import { MemoryStore } from "../src/memory-store.js";

describe("MemoryStore", () => {
  it("starts then replays", async () => {
    const s = new MemoryStore();
    const ttl = 1000;
    const k = "k1";
    const fp = "fp1";
    const b1 = await s.begin(k, fp, ttl);
    expect(b1.kind).toBe("started");
    await s.commit(k, {
      status: 201,
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
      fingerprint: fp,
      createdAt: Date.now()
    });
    const b2 = await s.begin(k, fp, ttl);
    expect(b2.kind).toBe("replay");
  });

  it("conflicts on different fingerprint", async () => {
    const s = new MemoryStore();
    const ttl = 1000;
    const k = "k2";
    const fp1 = "a";
    const fp2 = "b";
    await s.begin(k, fp1, ttl);
    const r = await s.begin(k, fp2, ttl);
    expect(r.kind).toBe("conflict");
  });

  it("inflight with same fp", async () => {
    const s = new MemoryStore();
    const ttl = 1000;
    const k = "k3";
    const fp = "x";
    await s.begin(k, fp, ttl);
    const r = await s.begin(k, fp, ttl);
    expect(r.kind).toBe("inflight");
  });
});
