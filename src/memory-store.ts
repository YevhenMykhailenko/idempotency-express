import { randomUUID } from "node:crypto";

import type { BeginResult, CachedResponse, Store } from "./types.js";

type Entry =
  | { state: "inflight"; fp: string; expiry: number; reservationId: string }
  | { state: "done"; fp: string; expiry: number; data: CachedResponse };

export class MemoryStore implements Store {
  private map = new Map<string, Entry>();
  private gcCalls = 0;

  async begin(key: string, fp: string, ttlMs: number): Promise<BeginResult> {
    this.gc(key);

    const now = Date.now();
    const entry = this.map.get(key);

    if (!entry) {
      const reservationId = randomUUID();
      this.map.set(key, { state: "inflight", fp, expiry: now + ttlMs, reservationId });
      return { kind: "started", reservationId };
    }

    if (entry.state === "inflight") {
      if (entry.fp === fp) return { kind: "inflight" };
      return { kind: "conflict" };
    }

    if (entry.expiry > now) {
      if (entry.fp === fp) return { kind: "replay", cached: entry.data };
      return { kind: "conflict" };
    }

    const reservationId = randomUUID();
    this.map.set(key, { state: "inflight", fp, expiry: now + ttlMs, reservationId });
    return { kind: "started", reservationId };
  }

  async commit(key: string, data: CachedResponse, reservationId?: string): Promise<void> {
    this.gc(key);
    const cur = this.map.get(key);
    if (!cur || cur.state !== "inflight" || cur.fp !== data.fingerprint) return;
    if (reservationId !== undefined && cur.reservationId !== reservationId) return;
    this.map.set(key, {
      state: "done",
      fp: cur.fp,
      expiry: cur.expiry,
      data
    });
  }

  async get(key: string): Promise<CachedResponse | null> {
    this.gc(key);
    const e = this.map.get(key);
    if (e && e.state === "done") return e.data;
    return null;
  }

  async abort(key: string, fp?: string, reservationId?: string): Promise<void> {
    const e = this.map.get(key);
    if (!e) return;
    if (e.state === "inflight" && (fp === undefined || e.fp === fp) &&
        (reservationId === undefined || e.reservationId === reservationId)) {
      this.map.delete(key);
    }
  }

  private gc(key: string) {
    const now = Date.now();
    if (++this.gcCalls % 256 === 0) {
      for (const [storedKey, entry] of this.map) {
        if (entry.expiry <= now) this.map.delete(storedKey);
      }
      return;
    }
    const e = this.map.get(key);
    if (!e) return;
    if (e.expiry <= now) this.map.delete(key);
  }
}
