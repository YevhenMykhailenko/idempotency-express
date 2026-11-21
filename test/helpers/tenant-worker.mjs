import { createClient } from "redis";

import { createTenantApi } from "../../dist/examples/tenant-api.js";
import { RedisStore } from "../../dist/src/redis.js";

const send = (message) => { if (process.connected) process.send(message); };
const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
client.on("error", () => {}); await client.connect();
let release;
let allowed = true;
const work = new Promise((resolve) => { release = resolve; });
process.on("message", (message) => {
  if (message.type === "release") release();
  if (message.type === "revoke") { allowed = false; send({ type: "revoked" }); }
});
class ObservedStore extends RedisStore {
  async begin(...args) { const result = await super.begin(...args); send({ type: "begin", kind: result.kind }); return result; }
  async commit(...args) { const result = await super.commit(...args); send({ type: "commit", kind: result.kind }); return result; }
}
const app = createTenantApi({
  store: new ObservedStore({ client }), namespace: "tenant-recipe-process",
  authenticate: (req) => ["Bearer fixture-old-token", "Bearer fixture-new-token"].includes(req.get("Authorization"))
    ? { tenantId: process.env.REDIS_WORKER_SCOPE, userId: "recipe-user" } : undefined,
  authorize: () => allowed,
  createOrder: async () => {
    send({ type: "handler" }); await work;
    const count = await client.incr(process.env.REDIS_WORKER_EFFECT_KEY);
    send({ type: "effect", count });
    return { id: `order_${process.pid}_${count}` };
  },
});
const server = app.listen(0, "127.0.0.1", () => { send({ type: "ready", port: server.address().port }); });
