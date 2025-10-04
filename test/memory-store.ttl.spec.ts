import { describe, it, expect, vi, afterEach } from "vitest";

import { MemoryStore } from "../src/memory-store.js";

describe("MemoryStore TTL and expiry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays within TTL and expires after TTL", async () => {
    const s = new MemoryStore();
    const key = "ttl-k1";
    const fp = "fp1";
    const ttl = 1000;

    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(1_000);
    const b1 = await s.begin(key, fp, ttl);
    expect(b1.kind).toBe("started");

    await s.commit(key, {
      status: 201,
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
      fingerprint: fp,
      createdAt: 1_000
    });

    nowSpy.mockReturnValue(1_500);
    const b2 = await s.begin(key, fp, ttl);
    expect(b2.kind).toBe("replay");

    nowSpy.mockReturnValue(2_200);
    const b3 = await s.begin(key, fp, ttl);
    expect(b3.kind).toBe("started");
  });

  it("returns conflict for different fingerprint within TTL", async () => {
    const s = new MemoryStore();
    const key = "ttl-k2";
    const fp1 = "A";
    const fp2 = "B";
    const ttl = 1000;
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(10_000);
    await s.begin(key, fp1, ttl);
    await s.commit(key, {
      status: 201,
      body: "x",
      headers: {},
      fingerprint: fp1,
      createdAt: 10_100
    });

    nowSpy.mockReturnValue(10_500);
    const r = await s.begin(key, fp2, ttl);
    expect(r.kind).toBe("conflict");
  });

  it("fallback commit path (no inflight) persists with sane TTL (>= 60s)", async () => {
    const s = new MemoryStore();
    const key = "ttl-k3";
    const fp = "fp";
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(50_000);
    await s.commit(key, {
      status: 201,
      body: "ok",
      headers: {},
      fingerprint: fp,
      createdAt: 50_000
    });

    nowSpy.mockReturnValue(50_100);
    const r = await s.begin(key, fp, 1000);
    expect(r.kind).toBe("replay");
  });
});
