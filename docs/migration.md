# Migration 2.x → 3.0

This is an operator runbook, **not an automatic migration tool or continuous protocol bridge**. Do not roll incompatible v2/v3 writers into one live logical request stream and assume a new prefix makes it safe.

## Breaking changes

| v2 | v3 |
| --- | --- |
| No mandatory application/user namespace | Required stable namespace and explicit scope |
| Missing key bypass by default | requireKey defaults to true; explicit opt-out has no deduplication guarantee |
| Raw client key lookup | `idem:v3:` + SHA-256 of JSON namespace/scope/key tuple |
| begin/get/commit and optional abort/token | protocolVersion 3, begin/read/commit, mandatory ownership token, no release/get/abort |
| Void commit / optional ownership | committed / canonical already-committed / reservation-lost |
| Cached body string or Buffer | Buffer only, strict bounded snapshots |
| Async storage without transport acknowledgement gate | Supported buffered result waits for commit ACK |
| Completed 5xx can release the key | All supported completed 200–599 responses, including 5xx, are retained |
| Captured/setOn implementation API | Removed; internal response state machine |
| Legacy ad-hoc status/error metadata | Stable idempotency error codes and explicit unknown outcomes |

Fingerprint format **2 is unchanged**. A package major version is not a reason to change frozen hashes. Nevertheless storage lookup and Store protocol are incompatible. A missing v3 key says nothing about an existing raw v2 key. Simply adding a prefix, flushing records or silently wrapping a v2 Store as protocol 3 can permit duplicate effects.

## Conservative cutover

1. Inventory **all** v2 writers, entrypoints, persistent stores, namespaces, live reservations and the longest configured legacy TTL. Document rollback and data-loss risks. Preserve legacy data; do not flush it.
2. Stop admission of new idempotent writes at a deployment/traffic gate **before either middleware**. Keep reads/status/reconciliation available where safe. Hold affected traffic explicitly; do not route around the guard.
3. Drain old in-flight business handlers and commits. Resolve crashed/unknown attempts through the authoritative business ledger/provider; HTTP 500, timeout or disconnect is not evidence of no effect.
4. Preserve the old deduplication window through the latest possible legacy expiry, with an operational safety margin and a verified inventory. Unknown TTL, still-running writers or unresolved effects keep the gate closed. Waiting an arbitrary fixed sleep is not a proof.
5. Approve stable namespaces, authorized scope mappings, parsers/fingerprint settings, Store protocol and failure handling for the **entire** new fleet. Update clients for required keys and unknown-result reconciliation. Verify the [guarantees](guarantees.md) and [Redis deployment policy](redis.md).
6. With old writers stopped, drain/retention verified and business reconciliation approved, switch all instances coherently. Reopen only approved new traffic. Quarantine/reconcile late legacy intents according to your business policy instead of pretending expired history proves they never happened.
7. Observe store errors, conflicts, unknown outcomes, capacity and business effect counts. Retain audit evidence and legacy data according to policy; cleanup is not the correctness mechanism.

This sacrifices write availability. It preserves the old **published retention boundary**, not infinite deduplication: a very old retry after TTL can still look new. Stable downstream/business uniqueness and reconciliation are essential when those intents may return.

## Identity and legacy responses

Never infer identity ownership from knowledge of a UUID/key or from the current request user. Legacy responses may lack enough identity metadata to prove they belong to a tenant/user. Do not copy/replay such data into a new scope. Holding or rejecting the request while reconciling is safer than cross-user replay.

If continuous availability is required, design a separate authenticated, atomic migration bridge that coordinates legacy claims/read/replay and v3 claims throughout live legacy retention. A naive read-old-then-write-new sequence has a race. No such bridge is implemented here; validate its safety independently rather than enabling an untested rolling mixed-major deployment.

Rollback also changes lookup/protocol. Switching back to v2 while new v3 operations are live can repeat them. Close the write gate and plan rollback for both histories; do not erase either Store to make rollback convenient.

## Custom Stores and verification

Implement the full Store v3 contract, not just a marker. Ownership/fingerprint/expiry checks and state transitions must be atomic. Commit never recreates a missing record, preserves deadline and returns the first canonical completion for repeat same-owner commits. Use detached byte/header snapshots and strict corrupt-data failures. Run the shared contract suite and backend faults, not just a TypeScript compile.

The migration tests in this repository model the deployment admission gate, retained anonymous legacy data and operator reconciliation approval. They demonstrate that a fresh v3 prefix cannot bypass those decisions and an unscoped legacy response is not promoted into another user's body. They are **not proof that your production inventory, cutover, rollback or continuous bridge has been executed successfully**. Validate the cutover and rollback in a test deployment before applying them to production.
