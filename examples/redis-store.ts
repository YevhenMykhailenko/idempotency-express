/**
 * Example Redis store (pseudo-implementation, requires 'redis' package).
 * Not exported from library to avoid hard dependency.
 */
// import { createClient } from "redis";
import type { Store, BeginResult, CachedResponse } from "../src/types.js";

/*
const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
*/

export class RedisStoreExample implements Store {
  // private client = client;

  async begin(key: string, fp: string, ttlMs: number): Promise<BeginResult> {
    // Use SETNX with PX=ttl, and store {state:'inflight', fp}
    // On existing key:
    //  - if 'inflight' with same fp -> inflight
    //  - if 'done' with same fp and not expired -> replay
    //  - else -> conflict
    return { kind: "started" }; // Placeholder
  }

  async commit(key: string, data: CachedResponse): Promise<void> {
    // Store as JSON and keep existing TTL
  }

  async get(key: string): Promise<CachedResponse | null> {
    return null;
  }
}
