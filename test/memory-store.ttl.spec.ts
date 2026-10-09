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

  it("ignores a commit without an active reservation", async () => {
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
    expect(r.kind).toBe("started");
  });

  it("does not let an old commit overwrite a newer reservation", async () => {
    const s = new MemoryStore();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    await s.begin("stale", "old", 100);

    nowSpy.mockReturnValue(1_101);
    await s.begin("stale", "new", 1_000);
    await s.commit("stale", {
      status: 201, body: "new response", headers: {}, fingerprint: "new", createdAt: 1_101
    });
    await s.commit("stale", {
      status: 201, body: "old response", headers: {}, fingerprint: "old", createdAt: 1_000
    });

    expect((await s.get("stale"))?.body).toBe("new response");
  });

  it("does not let an expired request commit or abort a new reservation with the same fingerprint", async () => {
    const s = new MemoryStore();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    const old = await s.begin("same", "fp", 100);
    expect(old.kind).toBe("started");
    if (old.kind !== "started") return;

    nowSpy.mockReturnValue(1_101);
    const current = await s.begin("same", "fp", 1_000);
    expect(current.kind).toBe("started");
    if (current.kind !== "started") return;

    await s.commit("same", {
      status: 201, body: "old", headers: {}, fingerprint: "fp", createdAt: 1_101
    }, old.reservationId);
    await s.abort("same", "fp", old.reservationId);
    expect((await s.begin("same", "fp", 1_000)).kind).toBe("inflight");

    await s.commit("same", {
      status: 201, body: "new", headers: {}, fingerprint: "fp", createdAt: 1_101
    }, current.reservationId);
    expect((await s.get("same"))?.body).toBe("new");
  });
});
