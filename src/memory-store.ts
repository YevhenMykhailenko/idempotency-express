import type { BeginResult, CachedResponse, Store } from "./types.js";

type Entry =
  | { state: "inflight"; fp: string; expiry: number }
  | { state: "done"; fp: string; expiry: number; data: CachedResponse };

export class MemoryStore implements Store {
  private map = new Map<string, Entry>();

  constructor() {}

  async begin(key: string, fp: string, ttlMs: number): Promise<BeginResult> {
    this.gc(key);

    const now = Date.now();
    const entry = this.map.get(key);

    if (!entry) {
      this.map.set(key, { state: "inflight", fp, expiry: now + ttlMs });
      return { kind: "started" };
    }

    if (entry.state === "inflight") {
      if (entry.fp === fp) return { kind: "inflight" };
      return { kind: "conflict" };
    }

    if (entry.expiry > now) {
      if (entry.fp === fp) return { kind: "replay", cached: entry.data };
      return { kind: "conflict" };
    }

    this.map.set(key, { state: "inflight", fp, expiry: now + ttlMs });
    return { kind: "started" };
  }

  async commit(key: string, data: CachedResponse): Promise<void> {
    const cur = this.map.get(key);
    if (!cur || cur.state !== "inflight") {
      this.map.set(key, {
        state: "done",
        fp: data.fingerprint,
        expiry: Date.now() + 60_000,
        data
      });
      return;
    }
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

  async abort(key: string, fp?: string): Promise<void> {
    const e = this.map.get(key);
    if (!e) return;
    if (e.state === "inflight" && (fp === undefined || e.fp === fp)) {
      this.map.delete(key);
    }
  }

  private gc(key: string) {
    const e = this.map.get(key);
    if (!e) return;
    if (e.expiry <= Date.now()) this.map.delete(key);
  }
}
