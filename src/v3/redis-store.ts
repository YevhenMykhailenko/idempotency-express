import { randomUUID } from "node:crypto";

import { StoreCapacityError, StoreDataError } from "./errors.js";
import { decodeRedisEntry, encodeRedisResponse } from "./redis-data.js";
import { REDIS_TRANSITION } from "./redis-scripts.js";
import { assertFingerprint, assertReservationId, assertStorageKey } from "./store-data.js";
import type { BeginResult, CachedResponse, CommitResult, Store, StoreEntry } from "./types.js";

/** Structural node-redis 5.x port. Use default string replies and a connected, application-owned client. */
export interface RedisClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export type RedisStoreOptions = { client: RedisClient };

/** Redis >=7.0, one authoritative clock and one key per transition. No connection ownership or retries. */
export class RedisStore implements Store {
  readonly protocolVersion = 3 as const;
  private readonly client: RedisClient;

  constructor(options: RedisStoreOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options) || typeof options.client?.eval !== "function") {
      throw new TypeError("A Redis client with eval is required");
    }

    this.client = options.client;
  }

  async begin(key: string, fingerprint: string, ttlMs: number): Promise<BeginResult> {
    assertStorageKey(key);
    assertFingerprint(fingerprint);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive safe integer");

    const result = await this.transition(key, ["begin", fingerprint, String(ttlMs), randomUUID()]);

    if (result[0] === "entry" && result.length === 2) {
      const entry = decodeRedisEntry(result[1]);

      if (entry.fingerprint !== fingerprint) return { kind: "conflict" };

      if (entry.kind === "completed") return { kind: "replay", entry };

      return { kind: "inflight", reservationId: entry.reservationId, expiresAt: entry.expiresAt };
    }

    if (result[0] === "started" && result.length === 3) {
      const reservationId = result[1];
      const expiresAt = Number(result[2]);

      assertReservationId(reservationId);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || String(expiresAt) !== result[2]) throw new StoreDataError();

      return { kind: "started", reservationId, expiresAt };
    }

    throw new StoreDataError("Invalid Redis begin result");
  }

  async read(key: string): Promise<StoreEntry | null> {
    assertStorageKey(key);
    const result = await this.transition(key, ["read"]);

    if (result[0] === "missing" && result.length === 1) return null;

    if (result[0] === "entry" && result.length === 2) return decodeRedisEntry(result[1]);

    throw new StoreDataError("Invalid Redis read result");
  }

  async commit(key: string, data: CachedResponse, reservationId: string): Promise<CommitResult> {
    assertStorageKey(key);
    assertReservationId(reservationId);
    const encoded = encodeRedisResponse(data);
    const fingerprint = data.fingerprint;
    const result = await this.transition(key, ["commit", fingerprint, reservationId, encoded]);

    if ((result[0] === "missing" || result[0] === "reservation-lost") && result.length === 1) return { kind: "reservation-lost" };

    if (result[0] === "committed" && result.length === 1) return { kind: "committed" };

    if (result[0] === "entry" && result.length === 2) {
      const entry = decodeRedisEntry(result[1]);

      if (entry.kind !== "completed") throw new StoreDataError();

      if (entry.reservationId !== reservationId || entry.fingerprint !== fingerprint) return { kind: "reservation-lost" };

      return { kind: "already-committed", entry };
    }

    throw new StoreDataError("Invalid Redis commit result");
  }

  private async transition(key: string, args: string[]): Promise<string[]> {
    let result: unknown;

    try { result = await this.client.eval(REDIS_TRANSITION, { keys: [key], arguments: args }); } catch (error) {
      if (args[0] === "begin" && error instanceof Error && /^OOM\b/.test(error.message)) throw new StoreCapacityError();

      throw error;
    }

    if (!Array.isArray(result) || result.some((value: unknown) => typeof value !== "string")) throw new StoreDataError();

    if (result[0] === "invalid") throw new StoreDataError("Corrupt or incompatible Redis record");

    if (args[0] === "begin" && result[0] === "range" && result.length === 1) {
      throw new RangeError("Reservation deadline exceeds the safe range");
    }

    return result as string[];
  }
}
