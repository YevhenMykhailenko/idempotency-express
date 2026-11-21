import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { connectRedisStore } from "./redis-store.js";
import { createTenantApi } from "./tenant-api.js";

/** Runnable single-identity DEMO; replace authentication, rate limiting and business logic in production. */
export async function startRedisDemo() {
  const { REDIS_URL, DEMO_TOKEN, DEMO_TENANT, DEMO_USER } = process.env;
  if (!REDIS_URL || !DEMO_TOKEN || !DEMO_TENANT || !DEMO_USER) throw new Error("Configure REDIS_URL and all DEMO_* credentials");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${DEMO_TOKEN}`);
  const { store, close } = await connectRedisStore(REDIS_URL);
  const app = createTenantApi({
    store, namespace: "orders-demo",
    authenticate: (req) => timingSafeEqual(digest(req.get("Authorization") ?? ""), expected)
      ? { tenantId: DEMO_TENANT, userId: DEMO_USER } : undefined,
    authorize: () => true, // Demo token has one preconfigured role; use your real per-request ACL.
    createOrder: async () => ({ id: `demo_${randomUUID()}` }), // No real payment/DB effect in this demo.
  });
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, "127.0.0.1", () => { console.warn(`Demo on http://127.0.0.1:${port}`); });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => { server.close(() => { void close().catch(() => { process.exitCode = 1; }); }); });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startRedisDemo().catch(() => { console.error("Redis demo startup failed; check configuration"); process.exitCode = 1; });
}
