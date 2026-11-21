# Redis operations (3.0)

Use `RedisStore` from `express-idempotency-middleware/redis` with an application-owned connected node-redis 5.x client and default string replies. No driver is imported by root or the adapter. The structural port is `eval(script, { keys: string[], arguments: string[] }): Promise<unknown>`; other clients require their own wrapper and verification.

Redis 7.0+ APIs are required; local backend verification started with Redis 7.4.5 standalone. Cluster/Sentinel/TLS/failover topologies are not a tested durability matrix. All workers must agree on namespace, scope and fingerprint rules. Never use a separate MemoryStore per worker as a distributed substitute.

```ts
import { createClient } from "redis";
import { RedisStore } from "express-idempotency-middleware/redis";

const client = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  socket: { connectTimeout: 3000 },
});
client.on("error", () => { console.error("Redis connection error"); });
await client.connect();
const store = new RedisStore({ client });
```

Configure authentication, TLS/network isolation, finite queues and client reconnect policy for your system. Driver Node requirements apply separately: current node-redis 5.12.2 requires Node 18.19+; older compatible clients need their own checks. The adapter never connects/closes/retries the client. A middleware deadline does not cancel an already submitted Redis command. Drain HTTP/business work before closing the client; do not turn connection failures into new keys.

## Record and atomicity contract

Each transition uses one scoped physical key: `idem:v3:` + SHA-256 of `JSON.stringify([namespace, scope, key])`. There is no local coordination lock or second lookup namespace. EVAL serializes the decision on the Redis server. Redis TIME establishes expiry, SET PXAT creates the reservation, SET XX KEEPTTL commits without extending it. Existing completed responses are never overwritten, including repeat commits from the same owner.

Wire version 1 has five LF-delimited metadata fields followed by an empty inflight suffix or completed response JSON with canonical base64 bytes. Type, version, lengths, metadata, PEXPIRETIME integrity, cached schema and fingerprints are checked. Corrupt/incompatible live records are protocol failures, not misses. The adapter does not repair, release, delete or silently rewrite them. Have a controlled incident/reconciliation process rather than flushing live data.

## Deployment requirements

- Use **`maxmemory-policy noeviction`** and capacity planning for the retention/retry window. OOM must remain a visible failure, not an eviction that silently allows another business operation.
- Isolate the keys from unrelated writers and TTL-changing cleanup jobs. Appropriate ACL permissions include EVAL and script commands TIME, TYPE, STRLEN, GET, PEXPIRETIME, SET on the required `idem:v3:*` keys. No DEL permission is needed by the adapter itself.
- Monitor capacity, error rates, latency, backend health and unknown outcomes. Do not use raw identity/key values as metric labels.
- Choose persistence and replication according to the business loss budget. RDB can lose writes since the last snapshot. AOF everysec still has a loss window; stronger fsync can reduce some windows but is not a transaction with an external effect.
- Asynchronous replication and failover can lose acknowledged writes. The adapter does not issue WAIT/WAITAOF, provide a quorum protocol, or promise a failover durability SLA. Verify your topology and recovery procedures independently.
- Backups, restore, flushing, eviction and changing namespaces can all invalidate deduplication history. Treat these operations as business-risk changes, not ordinary harmless cache maintenance.

The owned restart test disables RDB/AOF, obtains a completed ACK, restarts its own disposable server, then shows the same key can execute another effect after record loss. It deliberately does **not** expect impossible exactly-once behavior. Other tests use isolated keys and never FLUSHDB or restart the supplied REDIS_URL.

## Run the tests

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
# Also run the persistence-loss demo; requires Docker and locally available redis:7-alpine:
REDIS_URL=redis://127.0.0.1:6379 REDIS_RESTART_TEST=1 npm run test:redis
```

The suite requires a real backend and has no mock fallback. Exact fake-clock E-1/E/E+1 checks are Memory-specific; Redis expiry tests wait for authoritative Redis time, without rewriting TTL to manufacture expiry. Deliberate corruption tests mutate only their own records as fault injection.
