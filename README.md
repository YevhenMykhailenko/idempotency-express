# express-idempotency-middleware

[![npm version](https://img.shields.io/npm/v/express-idempotency-middleware.svg)](https://www.npmjs.com/package/express-idempotency-middleware)

> **3.0 — breaking changes from 2.x.** This README describes the v3 API: an explicit namespace and scope, Store protocol v3, and retained completed 4xx/5xx responses. Existing 2.x applications must follow the [migration runbook](docs/migration.md); a new key prefix alone is not a safe cutover.

Express middleware for coordinating repeated HTTP requests (mainly `POST`) using a scoped `Idempotency-Key`.
One request claims the key; identical retries return the stored HTTP result within its TTL, while conflicting payloads get `409`. Buffered responses are sent only after the Store acknowledges commit, including completed 4xx/5xx responses.

**This is not exactly-once execution of external business operations.** A payment and the stored HTTP result are not one transaction. Process crashes, TTL expiry, or lost Store data can leave the result unknown or permit another execution. Use downstream idempotency, business uniqueness, and reconciliation for critical effects.

---

## Highlights

- **Drop-in** per-route middleware
- **TypeScript-first**, ESM-only, Node ≥ 18
- Explicit application **namespace** and authenticated user/tenant **scope**
- Store protocol v3 with mandatory ownership tokens; bounded MemoryStore for dev/tests and a separate Redis adapter
- **In-flight control**: `wait` (with timeout) or `reject`
- **Safe headers at rest and replay** with a whitelist and hard denylist
- **Stable fingerprint**: method + path + normalized body + optional extra inputs
- **No partial fingerprints**: oversized bodies are rejected instead of being hashed only in part
- Designed for payments, orders, webhooks, and similar at-least-once scenarios

Guides: [guarantees and reconciliation](docs/guarantees.md) · [authenticated/webhook/multi-instance recipes](docs/recipes.md) · [Redis operations](docs/redis.md) · [2.x migration](docs/migration.md) · [security reporting](SECURITY.md) · [changelog](CHANGELOG.md).

---

## Install

The examples below use version 3.0:

```bash
npm i express-idempotency-middleware@3.0.0
# peer
npm i express
```

If 3.0.0 is not yet available in your registry, test a local checkout instead. With development Node 22.12+, run `npm ci`, `npm run build`, and `npm pack` in this repository; then install `/absolute/path/to/express-idempotency-middleware-3.0.0.tgz` in a separate consumer. Packing does not publish the package. An unqualified install follows the registry's `latest` tag, so confirm the installed major before using these examples.

> **ESM-only:** your project should use `"type": "module"` or native ESM (Node 18+).

Node 18+ compatibility is retained by explicit project decision. **Node 18 and 20 are upstream EOL**; prefer a maintained Node release for production. Library compatibility does not supply missing Node security updates or override a driver's own requirements.

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
    namespace: "payments-demo",
    scope: "public-demo", // Public demo only. Private APIs require an authenticated identity scope.
    ttlMs: 24 * 60 * 60 * 1000,
    inFlight: { strategy: "wait", waitTimeoutMs: 3000, pollMs: 100 },
    replay: { headerWhitelist: ["location"] }
  }),
  async (req, res) => {
    // Real payments also need downstream idempotency and business reconciliation.
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

Keys are 1–255 printable ASCII bytes excluding whitespace, commas, and double quotes; UUIDs are optional. Keys are required by default. Missing-key bypass requires explicit `requireKey: false` and has no deduplication guarantee.

Run authentication, **authorization**, body parsing, signature verification, rate limiting, and ordinary validation **before** this middleware, including before a replay. For a private route, derive `scope(req)` from the already authenticated identity, not a raw bearer token or unverified tenant header. Use an unambiguous tuple encoding for tenant + user identity. `fingerprint.custom` is not a substitute for scope.

---

## Examples / Usage

The **basic Express server** under `examples/` is runnable. The repository also has a Redis connection factory, authenticated tenant/user and verified webhook recipes, and a two-instance Redis demo. See [recipes](docs/recipes.md) for setup and security boundaries. The Postgres file remains a nonfunctional sketch. Examples compile into `dist/examples/` for repository use; they are not shipped in the npm tarball.

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
import type { IdempotencyEvent, Store } from "express-idempotency-middleware";

function idempotencyMiddleware(options: IdemOptions): RequestHandler;

type KeyOptions =
  | { keyHeader?: string; getKey?: never }
  | { getKey: (req: Request) => string | undefined; keyHeader?: never };

export type IdemOptions = KeyOptions & {
  store: Store;
  namespace: string;             // stable application identifier: [A-Za-z0-9._-], 1–128 chars
  scope: string | ((req: Request) => string); // explicit stable identity; no fallback
  ttlMs?: number;                // default 24h
  methods?: string[];            // default ["POST"]
  requireKey?: boolean;          // default true
  storeTimeoutMs?: number;       // default 2000, applies to each begin/read/commit
  maxResponseBytes?: number;     // default 256 KiB; range 0–1 MiB
  inFlight?: {                   // default {strategy: "reject"}
    strategy: "wait" | "reject";
    waitTimeoutMs?: number;      // default 5000
    pollMs?: number;             // default 100
  };
  fingerprint?: {
    includeQuery?: boolean;      // default false
    maxBodyBytes?: number;       // default 64KB; larger bodies return 413
    custom?: (req: Request) => string | undefined; // additional result-affecting inputs
  };
  replay?: {
    headerWhitelist?: string[];  // lowercase names, e.g., ["location"]
  };
  onEvent?: (event: IdempotencyEvent) => void | Promise<void>;
};
```

The default key header is `Idempotency-Key`. Duplicate raw headers are rejected. Custom `getKey` is synchronous, called once, and has no header fallback. For webhooks, verify the provider signature first, then extract the verified event ID.

`scope` is synchronous, nonempty, at most 1024 UTF-8 bytes, and cannot contain control characters. Invalid scope fails closed. Physical keys are `idem:v3:` + SHA-256 of `JSON.stringify([namespace, scope, key])`; method/path stay in the fingerprint, so reusing one key on another endpoint conflicts.

`maxBodyBytes` limits the complete canonical body, without truncation. JSON object keys are sorted; string values and array order are preserved. Buffers are hashed as bytes. Unsupported JavaScript objects/custom callback failures return `500 idempotency_fingerprint_failed` before claim. An unparsed nonempty body returns `400`; an oversized canonical body returns `413`. Keep the parser before this middleware. Fingerprint format 2 is unchanged.

### Store Interface

```ts
export type CachedResponse = {
  status: number;
  body: Buffer;
  headers: Record<string, string | string[]>;
  fingerprint: string;
  createdAt: number;
};

type Reservation = { reservationId: string; expiresAt: number };
type StoreEntry = Reservation & (
  | { kind: "inflight"; fingerprint: string }
  | { kind: "completed"; fingerprint: string; cached: CachedResponse }
);
type CompletedEntry = Extract<StoreEntry, { kind: "completed" }>;

export interface Store {
  readonly protocolVersion: 3;
  begin(key: string, fingerprint: string, ttlMs: number): Promise<
    | (Reservation & { kind: "started" })
    | { kind: "replay"; entry: CompletedEntry }
    | { kind: "conflict" }
    | (Reservation & { kind: "inflight" })
  >;
  read(key: string): Promise<StoreEntry | null>;
  commit(key: string, data: CachedResponse, reservationId: string): Promise<
    | { kind: "committed" }
    | { kind: "already-committed"; entry: CompletedEntry }
    | { kind: "reservation-lost" }
  >;
}
```

`begin` atomically claims or reads the existing state. `commit` checks live ownership and fingerprint; it never creates a missing reservation. Repeated same-owner commits return the **first** canonical result without overwriting it. There is no `get`, `abort`, or `release` API. Custom stores must implement the full atomic contract, strict data validation, and detached snapshots; the version marker alone does not prove correctness.

TTL starts at claim and is not extended by commit, polling, or replay. Choose it longer than the maximum handler duration plus commit budget. Expiry can allow another handler execution; ownership tokens protect Store records, not external effects. ACK is not a universal guarantee of durability after failover.

`new MemoryStore({ maxEntries: 256 })` is the default bounded, single-process, volatile dev/test Store. A full Store rejects new claims with `503 idempotency_capacity_exceeded`, without evicting live records. Body hard limit is 1 MiB; filtered headers are limited to 16 KiB per record.

---

## Behavior & Headers

- Adds response headers:
  - `Idempotency-Key`: echoes the key
  - `Idempotency-Status`: `created | cached | conflict | inflight | inflight-timeout | error`
  - `Idempotency-Replayed`: `true | false`
  - On in-flight timeout or reject: `Retry-After: 1`
- **Replay headers**: only those in `replay.headerWhitelist` are replayed, plus `content-type` is always replayed.
  Cookies/auth, `proxy-*`, hop-by-hop headers, Connection-nominated headers, content encoding/length, and `idempotency-*` headers are **never stored or replayed**, even if whitelisted. Body data is not redacted; sensitive bodies remain the application's responsibility.

### Failures and buffered responses

Supported: `res.json`, `res.send(string/Buffer)`, and one buffered `res.end` with string/Buffer/Uint8Array/empty body and standard encoding/callback overloads. Empty 204/205/304 results are replayed without synthetic body, Content-Type, or ETag. End/finish/callback happen after commit acknowledgement and transport completion; an end callback does not establish business success.

Streaming/SSE, application `write`/`writeHead`/`flushHeaders`, sendFile/download, trailers, upgrade, and manually compressed bodies are unsupported. Guards reject them without caching partial bytes or releasing the reservation. Direct socket writes are outside the supported protocol. For standard `compression`, the verified order is **compression → idempotency → handler**; stored bytes are uncompressed and replay is negotiated again. Arbitrary response transforms are not covered.

Own errors are JSON `{ "error": { "code": "idempotency_…", "message": "…", "outcome": "unknown" } }`; `outcome` is present for uncertain results. Important cases:

| Case | HTTP / error code |
| --- | --- |
| Missing / invalid key | 400 / `idempotency_key_required` / `idempotency_key_invalid` |
| Scope / extractor callback failure | 500 / `idempotency_scope_invalid` / `idempotency_extractor_failed` |
| Different fingerprint / outstanding operation / wait deadline | 409 / `idempotency_conflict` / `idempotency_inflight` / `idempotency_wait_timeout` |
| Begin/read failure or timeout / malformed Store result | 503 / `idempotency_store_unavailable` / `idempotency_store_invalid` |
| Commit failure/timeout/lost ownership | 503 / `idempotency_result_unknown` |
| Oversized / unsupported response | 503 / `idempotency_response_too_large` / `idempotency_response_unsupported` |

Store timeouts do not cancel backend work. Late commits may succeed, so a retry with the **same** key can replay the saved result. No failure, wait timeout, completed 5xx, or disconnect automatically releases the key. A disconnected owner's later supported response is still committed when possible. A waiter only reads its original reservation; it never claims a replacement after expiry.

**Do not universally retry with a new key after an unknown result.** Reconcile the business outcome, particularly after retention expiry. A crash after an external effect but before commit cannot be resolved by this middleware alone.

`onEvent` is optional, not awaited, and contains only low-cardinality diagnostics (`type`, optional operation/code/status/durationMs). It never includes raw keys, scope, tokens, fingerprints, bodies, headers, or backend errors. Throwing/rejected observers do not change HTTP/Store decisions. Do not put blocking work in a synchronous observer.

### Breaking changes from 2.x

Namespace/scope are required, keys are required by default, Store protocol v3 is incompatible with v2, `CachedResponse.body` is always Buffer, `Captured`/`setOn` are removed, and completed 5xx responses are now retained.

The new physical key prefix is **not a safe migration by itself**: a live v2 operation can appear absent in v3. Do not mix live v2/v3 writers, flush legacy keys, or replay legacy responses without verified identity ownership. Follow the [migration runbook](docs/migration.md): stop admission, drain old work, preserve legacy retention and reconcile uncertain business effects before a coordinated switch. Continuous migration requires a separate verified bridge. Policy-model tests do not establish that your production cutover has occurred.

---

## RedisStore

The separate `express-idempotency-middleware/redis` export does not import a Redis driver. Supply a connected client; the application owns connection/reconnect/shutdown policy. Verified locally with **Redis 7.4.5 standalone + node-redis 5.12.2**. Redis **7.0+** is required. Cluster/Sentinel and failover topologies have not been validated.

```bash
npm i redis@5
```

```ts
import { createClient } from "redis";
import { RedisStore } from "express-idempotency-middleware/redis";

const client = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
});
client.on("error", () => { console.error("Redis connection error"); });
await client.connect();
const store = new RedisStore({ client });
// Pass store to idempotencyMiddleware with your stable namespace and authorized scope.
// At application shutdown, after draining requests: await client.close();
```

The structural `RedisClient` port is `eval(script, { keys: string[], arguments: string[] }): Promise<unknown>`, with default string replies. Other clients need an explicit compatible wrapper and their own verification. The adapter never retries commands or manages the connection. Middleware deadlines do not cancel Redis work; configure finite client connection/queue budgets too. The example driver's own Node requirements apply independently of the library's runtime declaration.

### Atomicity, storage, and operations

- One physical scoped key and one Lua transition per operation; no process-local coordination. Redis `TIME` establishes expiry. Claim uses `SET PXAT`; owned commit uses `SET XX KEEPTTL`.
- Wire version 1 stores metadata and a bounded JSON response with canonical base64 body (about 33% binary encoding overhead). Read/replay and repeated commits validate schema, bytes, ownership and fingerprint; snapshots are detached. Corrupt/incompatible live records or altered/missing TTL fail closed without repair, release or overwrite.
- Use **`maxmemory-policy noeviction`**, adequate capacity, and a consistent authoritative Redis deployment. Evicting/deleting keys, restoring an older backup or losing acknowledged records breaks the deduplication assumption. Do not share these keys with processes that rewrite their values or TTL.
- Protect Redis with appropriate authentication/ACL, network isolation and TLS where needed. The adapter uses `EVAL` and script commands `TIME`, `TYPE`, `STRLEN`, `GET`, `PEXPIRETIME`, `SET` on `idem:v3:*`. Allow the required commands/keys; Redis errors are not cache misses.
- **An EVAL ACK is not disk/replica durability.** RDB can lose writes since the last snapshot; AOF `everysec` has a loss window; stronger fsync settings reduce some windows but do not make the business effect and Store atomic. Asynchronous replication/failover can lose acknowledged records. The adapter does not issue `WAIT`/`WAITAOF` or provide a failover durability SLA.
- Test persistence and recovery for your deployment. The isolated restart test deliberately disables RDB/AOF and demonstrates a second effect after acknowledged Store data is lost. This is the published boundary, not an exactly-once guarantee.

PostgreSQL remains deferred; `examples/postgres-store.ts` is a nonfunctional sketch, not an adapter or an atomic business-transaction integration.

---

## Best Practices

- Generate the key **client-side** (UUID v4) per unsafe request
- Include every input that affects the operation in the fingerprint. By default query parameters and request headers are excluded; use `includeQuery: true` and `custom` when they matter.
- Use the shared Redis adapter with the same namespace/scope/fingerprint rules on every instance; verify persistence/failover assumptions for your deployment
- Whitelist only **safe headers** to replay (e.g., `location`); `content-type` is always replayed
- Set TTL to cover your retry window and maximum execution + commit duration; do not treat expiry as proof that no effect occurred
- For webhooks, prefer provider event IDs (e.g., Stripe `event.id`) as the idempotency key

---

## Limitations

- Not designed for streaming responses or long-running jobs
  For multi-minute operations, prefer queues/outbox + status resources
- MemoryStore is single-process only and volatile; losing its records loses deduplication
- No atomic transaction with external effects; no exactly-once claim, even after Store ACK

---

## Troubleshooting

- **`ERR_MODULE_NOT_FOUND` after build**
  Ensure compiled imports include explicit `.js` extensions and your `package.json` `exports` point to `./dist/src/index.js`.

- **Second request shows `created` instead of `cached`**
  Check that both requests use the same store instance and the first response completed before the retry. A reservation that expires during a long handler can also allow a new execution; increase `ttlMs` or use a job/status workflow.

- **`r2.body` is `{}` or a JSON string in tests**
  Make sure `Content-Type: application/json` is set and that replay includes `content-type` (the middleware always replays it by default).

---

## Development (this repo)

Development tools require Node 22.12 or newer. Runtime declaration remains `>=18.0.0`. Locally verified on macOS:

| Node | Express / matching types | Verification |
| --- | --- | --- |
| 22.13.0, 24.22.3 | 4.22.3 / @types/express 4.17.23; 5.3.0 / @types/express 5.0.6 | Full source, HTTP/native/Redis/recipe/fault suites, build/types and installed tarball |
| 18.0.0 | Express 4.22.3 and 5.3.0 | Installed tarball HTTP/binary/204/500/gzip, no-driver imports, public types, Redis round-trip with node-redis 5.11.0 |
| 18.20.8, 20.20.2 | Express 4.22.3 and 5.3.0 | Same installed-tarball checks with node-redis 5.12.2 |

Legacy rows are runtime compatibility checks, not the Vitest development suite running on EOL Node. Types are compiled using the development runtime. Redis backend verification uses 7.4.5 standalone; other topologies/OS/runtime versions are not implied. CI is configured for Node 22/24 × Express 4/5 plus legacy installed-package jobs, but was not remotely executed during this local development stage.

```bash
npm ci
npm run build
npm test
# Example server (after build):
node dist/examples/server-basic.js
```

`npm test` runs the non-Redis suites. The separate integration command **requires** a reachable Redis, with no mock/skip fallback:

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

It uses unique keys and deletes only its own test records, never `FLUSHDB`. To include the persistence-loss demonstration, Docker and a locally available `redis:7-alpine` image are required:

```bash
REDIS_URL=redis://127.0.0.1:6379 REDIS_RESTART_TEST=1 npm run test:redis
```

That extra test restarts/removes only a disposable container it creates, not the supplied Redis service. CI enables it and runs real Redis tests on Node 22/24. `prepublishOnly` includes Redis, installed-package/docs checks and a blocking full `npm audit`; the local chain passed after the targeted development dependency remediation on 2026-11-19. Running the checks is not publication permission or proof that all release gates are complete. A clean development audit does not audit a consumer's Express peer, Store driver or application dependencies.

Additional checks:

```bash
# Actual pack/install outside this tree; checks imports with NO Redis driver first, paired public types,
# HTTP bytes/callbacks/gzip, then installs a driver and checks its structural port + Redis round-trip.
REDIS_URL=redis://127.0.0.1:6379 IDEM_REQUIRE_REDIS=1 npm run test:package
# Alternate Express runtime AND matching types in an owned disposable sandbox; working lockfile unchanged:
REDIS_URL=redis://127.0.0.1:6379 REDIS_RESTART_TEST=1 IDEM_MATRIX_FULL=1 npm run test:express
npm run test:docs
```

`test:express` defaults to Express 5; `IDEM_EXPRESS_MAJOR=4` selects 4. `IDEM_RUNTIME_NODE=/absolute/path/to/node` selects only the installed-package runtime while development tools stay on the host Node. For minimum Node 18.0.0 Redis checks use `IDEM_REDIS_CLIENT_VERSION=5.11.0`; the current 5.12.2 driver requires Node 18.19+. Package consumers and alternate dependencies live in temporary directories and are removed afterwards. `npm pack`/install is not publication. The dependency audit is an independent blocking CI gate, not suppressed by passing functional tests.

---

## License

MIT
