# Application recipes (3.0)

These are Express application examples, not new adapters or built-in authentication/business transactions. The executable sources are [tenant-api.ts](https://github.com/YevhenMykhailenko/idempotency-express/blob/main/examples/tenant-api.ts), [webhook-app.ts](https://github.com/YevhenMykhailenko/idempotency-express/blob/main/examples/webhook-app.ts), and [server-redis.ts](https://github.com/YevhenMykhailenko/idempotency-express/blob/main/examples/server-redis.ts) in this development tree; they may not yet exist on the public default branch. They are not installed from the npm tarball. Run the repository build to obtain `dist/examples/`.

## Authenticated tenant/user endpoint

Order the route as follows:

```text
authenticate → authorize → rate limit → parse → validate → idempotency → business handler
```

Authentication resolves stable IDs from a verified session/token. Authorization rechecks current access on **every request**, before a cached response is possible. A token refresh must not change scope; permissions may be revoked after the original response. Use an unambiguous tuple, e.g. `JSON.stringify([tenantId, userId])`, not delimiter concatenation or the bearer token itself. Never trust an arbitrary X-Tenant-ID header as identity.

`createTenantApi` accepts application-owned authenticate/authorize/createOrder callbacks and an optional pre-claim rate limiter. It keeps verified identity in a request-local WeakMap, then passes the tenant/user tuple to scope. The callback gets a stable downstream key derived from namespace/identity/route/client key. Your provider or business uniqueness constraint must actually enforce it; the example cannot do that for you.

If your application uses Express request augmentation instead, keep it application-local, for example:

```ts
declare global {
  namespace Express {
    interface Request { identity?: { tenantId: string; userId: string } }
  }
}
// Your verified auth middleware sets req.identity BEFORE this callback is reachable:
const scope = (req: import("express").Request) => {
  if (!req.identity) throw new Error("Missing authenticated identity");
  return JSON.stringify([req.identity.tenantId, req.identity.userId]);
};
```

Do not send PII unnecessarily: response bodies are stored unchanged. For errors after a possible business effect, complete an honest application response or use a status/reconciliation workflow; do not delete the key to make an automatic retry appear safe. Async handler errors must be forwarded explicitly in Express 4; the recipes do so and a completed central 500 is retained.

## Redis across multiple instances

Both processes use one appropriately configured shared Redis deployment, the same namespace, stable verified identity rules and fingerprint inputs. Do not invent per-instance namespaces or use a new Store for every request. See [Redis operations](redis.md).

From this repository, the runnable **single-identity demo** requires explicit credentials, has no real payment/DB effect and is not a production auth implementation:

```bash
npm ci
npm run build
# Supply real local demo values; do not hard-code production credentials in source/history.
REDIS_URL=redis://127.0.0.1:6379 DEMO_TOKEN="$LOCAL_DEMO_TOKEN" DEMO_TENANT=demo DEMO_USER=one PORT=3001 node dist/examples/server-redis.js
# Run the same configuration in a second terminal, with PORT=3002.
```

```bash
curl -i http://127.0.0.1:3001/orders -H "Authorization: Bearer $LOCAL_DEMO_TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: order-one' -d '{"amount":100,"currency":"USD"}'
curl -i http://127.0.0.1:3002/orders -H "Authorization: Bearer $LOCAL_DEMO_TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: order-one' -d '{"amount":100,"currency":"USD"}'
```

The second response is cached with the same order ID. In production replace the demo token check, fixed role, rate policy and simulated order callback with your verified auth/ACL, limiter, durable business ledger and downstream idempotency. Do not assume Redis alone supplies those controls. Drain active requests before client shutdown.

## Verified webhook event ID

Order matters:

```text
bounded raw body → provider signature + timestamp verification → parse/validate event
→ verified event ID extraction → idempotency → event handler
```

Mount the webhook route **before a global JSON parser**, or use route-specific parsers. Signature verification must see the exact received bytes. Verify authenticity on every delivery, even when the event ID is already cached; a known event ID is not authorization.

`createWebhookApp` demonstrates a deliberately **non-provider-compatible** protocol:

- `X-Webhook-Timestamp`: decimal Unix seconds, within ±300 seconds of the configured clock.
- `X-Webhook-Signature`: `v1=` plus lowercase hex HMAC-SHA256 of `timestamp + "." + rawBody`.
- Duplicate signature/timestamp headers are rejected; secrets must have at least 32 bytes.
- Raw parsing uses `inflate: false`: compressed request bodies are rejected with 415 rather than substituting decompressed bytes for the signed payload. A broken configured clock fails closed.
- Signed JSON contains `id` (1–128 `[A-Za-z0-9._-]` characters), nonempty `type`, and `data`.
- Scope uses the server-configured verified account ID, never an unsigned account header. Multiple active secrets can support rotation without changing account/event scope.
- getKey uses only the verified event ID. Delivery timestamps/signatures and an unrelated Idempotency-Key header do not create new operations. Changed data for the same event ID conflicts.

For Stripe, GitHub or another provider, replace this demo verification with the provider's official SDK/protocol. Do not feed this HMAC format to their real endpoint or claim compatibility. For multi-account secrets, authenticate and authorize the account mapping before selecting scope; never blindly use a signed-but-unmapped tenant field.

The shared recipe suite runs against MemoryStore and real Redis: refreshed credentials, revoked authorization, identity separation, pre-claim 400/429, signed retries/secret rotation, invalid/stale signature, conflicting event payload and retained 500. It also demonstrates an intentionally wrong auth-after-idempotency app to explain why that deployment is unsafe; the middleware cannot reorder application security controls.
