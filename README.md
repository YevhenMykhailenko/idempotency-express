# express-idempotency-middleware

[![npm version](https://img.shields.io/npm/v/express-idempotency-middleware.svg)](https://www.npmjs.com/package/express-idempotency-middleware)  
[![CI](https://github.com/YevhenMykhailenko/idempotency-express/actions/workflows/ci.yml/badge.svg)](https://github.com/YevhenMykhailenko/idempotency-express/actions/workflows/ci.yml)

Express middleware that makes **unsafe** HTTP requests (mainly `POST`) **idempotent** using an `Idempotency-Key`.  
The first request executes your handler and caches `{status, body, headers(whitelist)}` for a TTL. Identical retries return the cached response. Conflicting payloads get `409 Conflict`. Concurrency is handled via `wait` or `reject` strategies.

---

## Highlights

- **Drop-in** per-route middleware  
- **TypeScript-first**, ESM-only, Node ≥ 18  
- Pluggable **stores**: built-in Memory (dev). Example Redis/Postgres stores in `examples/`  
- **In-flight control**: `wait` (with timeout) or `reject`  
- **Safe replay** with **header whitelist** (never replays cookies/auth)  
- **Stable fingerprint**: method + path + normalized body + optional tenant/user  
- Designed for payments, orders, webhooks, and similar at-least-once scenarios

---

## Install

```bash
npm i express-idempotency-middleware
# peer
npm i express
```

> **ESM-only:** your project should use `"type": "module"` or native ESM (Node 18+).

---

## Quick Start

```ts
import express from "express";
import { idempotencyMiddleware, MemoryStore } from "express-idempotency-middleware";

const app = express();
app.use(express.json());

const store = new MemoryStore();

app.post(
  "/payments",
  idempotencyMiddleware({
    store,
    ttlMs: 24 * 60 * 60 * 1000,
    inFlight: { strategy: "wait", waitTimeoutMs: 3000, pollMs: 100 },
    replay: { headerWhitelist: ["location"] }
  }),
  async (req, res) => {
    // your business logic
    const orderId = "ord_" + Math.random().toString(36).slice(2);
    res.setHeader("Location", `/orders/${orderId}`);
    res.status(201).json({ orderId });
  }
);

app.listen(3000);
```

**Client header:**

```
Idempotency-Key: <uuid-v4>
```

---

## Examples / Usage

This repo ships with runnable examples under `examples/`. The quickest way to try the middleware is the **basic Express server**.

### Run the example (from this repo)

```bash
npm i
npm run build
node dist/examples/server-basic.js
# Server: http://localhost:3000
```

### 1) First request (create)

```bash
curl -i -X POST http://localhost:3000/payments   -H "Content-Type: application/json"   -H "Idempotency-Key: key-123"   -d '{"amount":100}'
```

**Expected:**

- `HTTP/1.1 201 Created`
- `Idempotency-Status: created`
- Body: `{"orderId":"..."}`

### 2) Replay — same key & same payload

```bash
curl -i -X POST http://localhost:3000/payments   -H "Content-Type: application/json"   -H "Idempotency-Key: key-123"   -d '{"amount":100}'
```

**Expected:**

- `HTTP/1.1 201 Created` (same status as the first response)  
- `Idempotency-Status: cached`  
- `Idempotency-Replayed: true`  
- `Content-Type: application/json; charset=utf-8`  
- Body: **identical** to the first response (same `orderId`)

### 3) Conflict — same key, different payload

```bash
curl -i -X POST http://localhost:3000/payments   -H "Content-Type: application/json"   -H "Idempotency-Key: key-123"   -d '{"amount":200}'
```

**Expected:**

- `HTTP/1.1 409 Conflict`
- `Idempotency-Status: conflict`

### 4) In-flight duplicates (concurrency)

The example route simulates ~300 ms of work and uses `inFlight: { strategy: "wait", waitTimeoutMs: 3000 }`.  
Open two terminals and run the same request with the same key as fast as possible.  
The second request will **wait** and return the cached result:

- `Idempotency-Status: cached`  
- `Idempotency-Replayed: true`

---

## API

```ts
import type { RequestHandler, Request } from "express";

function idempotencyMiddleware(options: IdemOptions): RequestHandler;

export type IdemOptions = {
  store: Store;
  ttlMs?: number;                // default 24h
  methods?: string[];            // default ["POST"]
  keyHeader?: string;            // default "Idempotency-Key"
  requireKey?: boolean;          // default false (400 if true and missing)
  inFlight?: {                   // default {strategy: "reject"}
    strategy: "wait" | "reject";
    waitTimeoutMs?: number;      // default 5000
    pollMs?: number;             // default 100
  };
  fingerprint?: {
    includeQuery?: boolean;      // default false
    maxBodyBytes?: number;       // default 64KB
    custom?: (req: Request) => string | undefined; // e.g., tenant/user id
  };
  replay?: {
    headerWhitelist?: string[];  // lowercase names, e.g., ["location"]
  };
};
```

### Store Interface

```ts
export type CachedResponse = {
  status: number;
  body: string | Buffer;
  headers: Record<string, string | string[]>;
  fingerprint: string;
  createdAt: number;
};

export interface Store {
  begin(key: string, fp: string, ttlMs: number): Promise<
    | { kind: "started" }
    | { kind: "replay"; cached: CachedResponse }
    | { kind: "conflict" }
    | { kind: "inflight" }
  >;
  commit(key: string, data: CachedResponse): Promise<void>;
  get(key: string): Promise<CachedResponse | null>;
}
```

---

## Behavior & Headers

- Adds response headers:
  - `Idempotency-Key`: echoes the key  
  - `Idempotency-Status`: `created | cached | conflict | inflight | inflight-timeout | missing-key`  
  - `Idempotency-Replayed`: `true | false`  
  - On in-flight timeout or reject: `Retry-After: 1`
- **Replay headers**: only those in `replay.headerWhitelist` are replayed, plus `content-type` is always replayed.  
  Sensitive headers (`set-cookie`, `authorization`, `www-authenticate`, `proxy-*`) are **never** replayed.

---

## Using Redis / Postgres (examples)

`Redis` and `Postgres` stores are provided as **examples** (no hard deps).  
See `examples/redis-store.ts` and `examples/postgres-store.ts` for sketches.

**Typical approach (Redis sketch):**
```ts
// requires: npm i redis
// import { createClient } from "redis";
// const client = createClient({ url: process.env.REDIS_URL });
// await client.connect();

import type { Store, CachedResponse } from "express-idempotency-middleware";

class RedisStore implements Store {
  async begin(key: string, fp: string, ttlMs: number) {
    // Use SETNX + PX (or a Lua script) to atomically claim the key
    // Return: {kind:"started"} | {kind:"replay", cached} | {kind:"conflict"} | {kind:"inflight"}
    return { kind: "started" };
  }
  async commit(key: string, data: CachedResponse) {
    // Persist final response (JSON + keep TTL)
  }
  async get(key: string) {
    // Read cached response (if any)
    return null;
  }
}
```

**Typical approach (Postgres sketch):**
```sql
-- One possible schema (sketch)
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
```
```ts
// Use INSERT ... ON CONFLICT to claim/update atomically inside a transaction.
```

> Keep TTL moderate (hours). Store only safe headers. Avoid caching 5xx responses.

---

## Best Practices

- Generate the key **client-side** (UUID v4) per unsafe request  
- Fingerprint only what’s necessary (method, path, normalized body, tenant/user)  
- Use a **centralized store** (Redis/PG) in production; MemoryStore is for dev/tests  
- Whitelist only **safe headers** to replay (e.g., `location`); `content-type` is always replayed  
- Keep TTL short (hours, not days). Consider background cleanup for SQL stores  
- For webhooks, prefer provider event IDs (e.g., Stripe `event.id`) as the idempotency key

---

## Limitations

- Not designed for streaming responses or long-running jobs  
  For multi-minute operations, prefer queues/outbox + status resources
- MemoryStore is single-process only and volatile; use Redis/PG in production

---

## Troubleshooting

- **`ERR_MODULE_NOT_FOUND` after build**  
  Ensure compiled imports include explicit `.js` extensions and your `package.json` `exports` point to `./dist/src/index.js`.

- **Second request shows `created` instead of `cached`**  
  Ensure you’re on a version where the MemoryStore uses a sane fallback TTL and the middleware commits on `finish`.

- **`r2.body` is `{}` or a JSON string in tests**  
  Make sure `Content-Type: application/json` is set and that replay includes `content-type` (the middleware always replays it by default).

---

## Development (this repo)

```bash
npm i
npm run build
npm test
# Example server (after build):
node dist/examples/server-basic.js
```

---

## License

MIT
