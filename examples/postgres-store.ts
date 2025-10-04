/**
 * Example Postgres store (pseudo-implementation, requires 'pg' package).
 * Not exported from library to avoid hard dependency.
 */
// import { Pool } from "pg";
import type { Store, BeginResult, CachedResponse } from "../src/types.js";

/*
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

-- schema idea:
CREATE TABLE idem_keys (
  key text PRIMARY KEY,
  fp text NOT NULL,
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
  async begin(key: string, fp: string, ttlMs: number): Promise<BeginResult> {
    // Use INSERT ... ON CONFLICT with state machine semantics (in tx).
    return { kind: "started" }; // Placeholder
  }
  async commit(key: string, data: CachedResponse): Promise<void> {
    // UPDATE row to state='done', store response, keep expiry
  }
  async get(key: string): Promise<CachedResponse | null> {
    return null;
  }
}
