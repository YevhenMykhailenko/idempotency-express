import { randomUUID } from "node:crypto";

import { StoreCapacityError, StoreDataError } from "./errors.js";
import { DEFAULT_MEMORY_MAX_ENTRIES } from "./limits.js";
import {
  assertFingerprint,
  assertReservationId,
  assertStorageKey,
  cloneEntry,
  snapshotCachedResponse,
} from "./store-data.js";
import type { BeginResult, CachedResponse, CommitResult, MemoryStoreOptions, Store, StoreEntry } from "./types.js";

/** Bounded, volatile single-process Store; live entries are never evicted for capacity. */
export class MemoryStore implements Store {
  readonly protocolVersion = 3 as const;
  private readonly entries = new Map<string, StoreEntry>();
  private readonly maxEntries: number;

  constructor(options: MemoryStoreOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("MemoryStore options must be an object");
    }

    const prototype: unknown = Object.getPrototypeOf(options);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("MemoryStore options must be a plain object");
    }

    const configuredMaxEntries = options.maxEntries;
    const maxEntries = configuredMaxEntries === undefined ? DEFAULT_MEMORY_MAX_ENTRIES : configuredMaxEntries;

    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }

    this.maxEntries = maxEntries;
  }

  async begin(key: string, fingerprint: string, ttlMs: number): Promise<BeginResult> {
    assertStorageKey(key);
    assertFingerprint(fingerprint);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive safe integer");
    }

    const now = this.now();
    const expiresAt = now + ttlMs;

    if (!Number.isSafeInteger(expiresAt)) throw new RangeError("Reservation deadline exceeds the safe range");

    const current = this.liveEntry(key, now);

    if (current) {
      if (current.fingerprint !== fingerprint) return { kind: "conflict" };

      if (current.kind === "completed") return { kind: "replay", entry: cloneEntry(current) };

      return { kind: "inflight", reservationId: current.reservationId, expiresAt: current.expiresAt };
    }

    if (this.entries.size >= this.maxEntries) {
      for (const [storedKey, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(storedKey);
      }

      if (this.entries.size >= this.maxEntries) throw new StoreCapacityError();
    }

    const reservationId = randomUUID();

    this.entries.set(key, { kind: "inflight", fingerprint, reservationId, expiresAt });

    return { kind: "started", reservationId, expiresAt };
  }

  async read(key: string): Promise<StoreEntry | null> {
    assertStorageKey(key);
    const entry = this.liveEntry(key, this.now());

    return entry ? cloneEntry(entry) : null;
  }

  async commit(key: string, data: CachedResponse, reservationId: string): Promise<CommitResult> {
    assertStorageKey(key);
    assertReservationId(reservationId);
    const cached = snapshotCachedResponse(data);
    const current = this.liveEntry(key, this.now());

    if (!current || current.reservationId !== reservationId || current.fingerprint !== cached.fingerprint) {
      return { kind: "reservation-lost" };
    }

    if (current.kind === "completed") return { kind: "already-committed", entry: cloneEntry(current) };

    this.entries.set(key, { ...current, kind: "completed", cached });

    return { kind: "committed" };
  }

  private liveEntry(key: string, now: number): StoreEntry | undefined {
    const entry = this.entries.get(key);

    if (entry && entry.expiresAt <= now) {
      this.entries.delete(key);

      return undefined;
    }

    return entry;
  }

  private now(): number {
    const now = Date.now();

    if (!Number.isSafeInteger(now) || now < 0) throw new StoreDataError("Invalid store clock");

    return now;
  }
}
