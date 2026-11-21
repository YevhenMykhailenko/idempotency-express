# Guarantees and failure handling (3.0)

## What is coordinated

For one stable `(namespace, scope, client key)`, an atomic Store grants one live reservation. The matching request fingerprint may subsequently replay its completed HTTP result; a different fingerprint conflicts. All instances must use the same identity, fingerprint, parser and Store rules. Authenticate **and authorize every request before middleware**, including retries.

These guarantees assume a correct Store, retained records, unexpired TTL, and a supported buffered response path. `created` means an HTTP result was stored, not that the business operation succeeded. A completed 500 is also stored. `cached` does not bypass authorization.

## Not exactly-once business execution

A charge, database mutation, email, or message is **not in the same transaction** as Store commit. A process can perform that effect and crash before storing the HTTP result. Middleware cannot distinguish that case from a crash before the effect. The reservation stays inflight until expiry; it is not released as a recovery shortcut.

Ownership tokens protect Store records from stale writers, not external systems. Expiry, eviction, deleted records, restoring an old backup, or lossy Redis failover may permit another execution. Store ACK is not a universal disk/replica durability guarantee. See [Redis operations](redis.md).

Use an appropriate combination of:

- Stable downstream idempotency keys, with a verified provider retention/atomicity contract.
- Business uniqueness constraints and an operation ledger in the authoritative database.
- A database transaction/outbox for related business writes and events.
- An authenticated status resource and reconciliation of uncertain outcomes.

Merely passing a key into a callback does not implement those guarantees.

## TTL and deadlines

- `ttlMs` defaults to 24 hours and starts at the initial claim. Read, replay, polling and commit never extend it.
- Choose retention to cover the retry window **and** maximum handler duration plus commit budget. Bound business handlers separately: middleware has no handler cancellation/timeout guarantee.
- If a handler outlives TTL, a new claim may run while the old handler is still performing effects. Its stale token cannot overwrite the new Store record, but cannot fence the external effect.
- `storeTimeoutMs` defaults to 2000 ms per begin/read/commit. It limits local waiting, **not backend execution**. Late promises are observed; a late begin does not invoke the handler, and a late commit may still become replayable.
- Wait defaults: reject; opt-in wait uses 5000 ms / 100 ms polling. A waiter follows its original token/deadline, never becomes a replacement owner. Disconnect stops its local polls/timers without changing shared state.
- Local deadlines use monotonic elapsed time; backend expiry is authoritative. Redis uses Redis TIME, not worker Date.now. Blocking the event loop can delay any local timer.

## Failure matrix

Own errors use `{ "error": { "code": "idempotency_…", "message": "…", "outcome": "unknown" } }`. The `outcome` field is present only for uncertain results below. Its absence is **not evidence that no historical attempt/effect happened**.

| Condition | HTTP / code suffix | Current handler | Unknown field / state |
| --- | --- | --- | --- |
| Missing required key | 400 `key_required` | Not started | No Store call |
| Invalid or duplicate key | 400 `key_invalid` | Not started | No claim; no invalid-key echo |
| Key extractor throws/invalid type/Promise | 500 `extractor_failed` | Not started | No claim |
| Scope invalid/throws/Promise | 500 `scope_invalid` | Not started | No fallback scope |
| Nonempty body not parsed | 400 `body_unparsed` | Not started | No claim |
| Canonical body exceeds request limit | 413 `body_too_large` | Not started | No truncation/claim |
| Unsupported request object/fingerprint callback error | 500 `fingerprint_failed` | Not started | No claim |
| Claim capacity refusal | 503 `capacity_exceeded` | Not started | No live eviction |
| Begin/read exception or operation deadline | 503 `store_unavailable` | Not started | Backend may already have a reservation |
| Malformed/corrupt Store result before handler | 503 `store_invalid` | Not started | Not a miss; no repair/deletion |
| Different fingerprint | 409 `conflict` | Not started | Existing operation unchanged |
| Outstanding operation, reject strategy | 409 `inflight` | Not started | `unknown`; unchanged |
| Wait budget exhausted | 409 `wait_timeout` | Not started | `unknown`; unchanged |
| Wait loses original token, or stale start outlives retention | 503 `result_unknown` | Not started | `unknown`; no replacement claim |
| Supported final response, commit ACK | Original 200–599 | Ran once | Completed, including handler 4xx/5xx |
| Commit fails/times out/loses ownership/returns invalid data | 503 `result_unknown` | May have performed effect | `unknown`; may be inflight, completed or inaccessible |
| Captured body/headers exceed bounds | 503 `response_too_large` | May have performed effect | `unknown`; no partial cache/release |
| Unsupported response API | 503 `response_unsupported`, or socket close | May have performed effect | `unknown`; no partial cache/release |
| Owner disconnect before end | Possibly no response | May have performed effect | Reservation retained; later supported end still attempts commit |
| Crash after commit before HTTP delivery | No response | Already ran | Completed can be replayed |
| Crash between external effect and commit | No response | Unknown to client | Inflight until expiry; reconcile externally |

`Idempotency-Status` is `created`, `cached`, `conflict`, `inflight`, `inflight-timeout`, or `error`. `Idempotency-Replayed` is true only for cached; valid keys are echoed. `Retry-After: 1` is emitted only for inflight/wait-timeout and does not promise completion in one second. This is not a claim of conformance to an IETF Idempotency-Key draft profile.

## Reconciliation playbook

1. Keep the original identity, namespace, key and payload. Do not universally generate a new key after 5xx, disconnect or an unknown response.
2. Query the application's authoritative operation/status ledger, with authorization. A middleware inflight record alone cannot establish whether a charge happened.
3. Within retention, a same-key retry may read the completed result or continue reporting unknown. Do not blindly hammer the endpoint; apply client backoff and business deadlines.
4. After expiry or Store loss, absence is not proof of an unused business intent. Resolve with the downstream provider/ledger before authorizing another attempt.
5. If an operator decides another attempt is safe, that is an application/business decision, not a generic middleware release API. Preserve an audit trail. Never restore availability by deleting reservations indiscriminately.

## Responses, resources and privacy

Supported: status/header setters, json/send, a single buffered end with string/Buffer/Uint8Array/empty body and normal encoding/callback overloads. Snapshot and commit happen once before real transport end. End callbacks run at most once after the terminal response finishes; a technical 503 callback does not establish business success. Bodyless 204/205/304 use empty buffers.

Unsupported: application write/writeHead/flushHeaders, streaming/SSE, sendFile/download, trailers, interim/upgrade paths, manual compressed bodies and direct socket writes. Guards prevent the first supported-to-detect application write from escaping; uncontrolled socket access is outside the protocol. Do not describe arbitrary response transforms as compatible. Verified standard compression order: `compression → idempotency → handler`, with uncompressed stored bytes and fresh transport negotiation on replay.

Defaults: canonical request body 64 KiB, response body 256 KiB (configurable up to 1 MiB), filtered header JSON 16 KiB, MemoryStore 256 inflight/completed entries. MemoryStore is volatile, single-process **dev/test only** for distributed deployments; it rejects new claims at capacity rather than evicting live records. JavaScript overhead is extra; there is no aggregate RAM SLA. Redis base64 adds about 33% body encoding overhead. Polling 1000 waiters every 100 ms can cause roughly 10,000 reads/s.

Only content-type and whitelisted headers reach Store. Cookies/auth, proxy/hop-by-hop/Connection-nominated headers, content length/encoding and idempotency metadata are denied regardless of whitelist. Fault responses discard handler-specific headers while retaining safe pre-handler security/CORS baselines. **Bodies are not redacted or encrypted.** Sensitive response data needs application access controls, retention and Store protection. `onEvent` excludes keys/scopes/tokens/fingerprints/bodies/headers/raw errors; isolate observer failures and avoid blocking work or high-cardinality labels.

See [recipes](recipes.md), [migration](migration.md), and [security reporting](../SECURITY.md).
