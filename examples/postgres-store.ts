/**
 * Example Postgres store (pseudo-implementation, requires 'pg' package).
 * Not exported from library to avoid hard dependency.
 */
// import { Pool } from "pg";
import type { Store, BeginResult, CachedResponse, CommitResult, StoreEntry } from "../src/types.js";

/*
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

-- schema idea:
CREATE TABLE idem_keys (
  key text PRIMARY KEY,
  fp text NOT NULL,
  reservation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('inflight','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expiry timestamptz NOT NULL,
  status int,
  headers jsonb,
  body bytea
);
CREATE INDEX ON idem_keys (expiry);
*/

export class PostgresStoreExample implements Store {
  readonly protocolVersion = 3 as const;
  async begin(key: string, fp: string, ttlMs: number): Promise<BeginResult> {
    // Use INSERT ... ON CONFLICT with state machine semantics (in tx).
    throw new Error("PostgresStoreExample is a sketch, not an implementation");
  }
  async commit(key: string, data: CachedResponse, reservationId: string): Promise<CommitResult> {
    // Atomically check token/fingerprint/expiry; keep expiry and the first completed snapshot.
    // Return committed / canonical already-committed / reservation-lost; never release on 5xx.
    throw new Error("PostgresStoreExample is a sketch, not an implementation");
  }
  async read(key: string): Promise<StoreEntry | null> {
    throw new Error("PostgresStoreExample is a sketch, not an implementation");
  }
}
