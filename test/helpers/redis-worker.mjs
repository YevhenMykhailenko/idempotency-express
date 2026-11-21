import express from "express";
import { createClient } from "redis";

import { idempotencyMiddleware } from "../../dist/src/index.js";
import { RedisStore } from "../../dist/src/redis.js";

const clock = Date.now;
Date.now = () => clock() + Number(process.env.REDIS_WORKER_CLOCK_SKEW ?? 0);
const send = (message) => { if (process.connected) process.send(message); };
const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
client.on("error", () => {});
await client.connect();
let release;
const work = new Promise((resolve) => { release = resolve; });
process.on("message", (message) => { if (message.type === "release") release(); });
const mode = process.env.REDIS_WORKER_MODE;
class ObservedStore extends RedisStore {
  async begin(...args) {
    const result = await super.begin(...args);
    send({ type: "begin", kind: result.kind, expiresAt: result.expiresAt });
    return result;
  }
  async commit(...args) {
    const result = await super.commit(...args);
    send({ type: "commit", kind: result.kind });
    if (mode === "after-commit") await new Promise(() => {});
    return result;
  }
}
const app = express();
app.use(express.json());
app.post("/orders", idempotencyMiddleware({
  store: new ObservedStore({ client }), namespace: "redis-process", scope: process.env.REDIS_WORKER_SCOPE,
  ttlMs: 10_000, storeTimeoutMs: 2000,
  inFlight: process.env.REDIS_WORKER_REJECT === "1" ? { strategy: "reject" } : { strategy: "wait", waitTimeoutMs: 5000, pollMs: 10 },
}), async (_req, res) => {
  send({ type: "handler" });
  try {
    let effect;
    if (mode === "after-effect") {
      effect = await client.incr(process.env.REDIS_WORKER_EFFECT_KEY);
      send({ type: "effect", count: effect });
      await work;
    } else {
      await work;
      effect = await client.incr(process.env.REDIS_WORKER_EFFECT_KEY);
      send({ type: "effect", count: effect });
    }
    res.status(201).json({ id: "one", effect, worker: process.pid });
  } catch (error) { send({ type: "fatal", message: String(error) }); res.destroy(); }
});
const server = app.listen(0, "127.0.0.1", () => { send({ type: "ready", port: server.address().port }); });
