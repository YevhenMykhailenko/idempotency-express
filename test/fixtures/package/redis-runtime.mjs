import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import express from "express";
import { createClient } from "redis";
import { idempotencyMiddleware } from "express-idempotency-middleware";
import { RedisStore } from "express-idempotency-middleware/redis";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL required for installed Redis runtime smoke");
const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
client.on("error", () => {}); await client.connect();
const key = "idem:v3:" + createHash("sha256").update(JSON.stringify(["tarball", "public-test", randomUUID()])).digest("hex");
const scope = randomUUID();
const httpKey = "idem:v3:" + createHash("sha256").update(JSON.stringify(["tarball-http", scope, "key"])).digest("hex");
try {
  const store = new RedisStore({ client });
  const fingerprint = "a".repeat(64);
  const owner = await store.begin(key, fingerprint, 10_000);
  assert.equal(owner.kind, "started");
  const cached = { status: 500, body: Buffer.from([0, 255, 128]), headers: { "x-values": ["one", "two"] }, fingerprint, createdAt: Date.now() };
  assert.deepEqual(await store.commit(key, cached, owner.reservationId), { kind: "committed" });
  const result = await store.begin(key, fingerprint, 100_000);
  assert.equal(result.kind, "replay"); assert.equal(result.entry.expiresAt, owner.expiresAt);
  assert.ok([null, Object.prototype].includes(Object.getPrototypeOf(result.entry.cached.headers)));
  assert.deepEqual({ ...result.entry.cached, headers: { ...result.entry.cached.headers } }, cached);
  const app = express();
  app.use(express.json());
  let effects = 0;
  app.post("/orders", idempotencyMiddleware({ store, namespace: "tarball-http", scope }), (_req, res) => {
    effects++; res.status(500).end(Buffer.from([0, 255, 128]));
  });
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const send = () => new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: server.address().port, path: "/orders", method: "POST", agent: false,
        headers: { "Idempotency-Key": "key", "Content-Length": "0" } }, (res) => {
        const chunks = []; res.on("data", (chunk) => { chunks.push(chunk); }); res.once("error", reject);
        res.once("end", () => { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      });
      req.once("error", reject); req.end();
    });
    const first = await send(); const second = await send();
    assert.equal(first.status, 500); assert.equal(second.status, 500);
    assert.equal(first.headers["idempotency-status"], "created"); assert.equal(second.headers["idempotency-status"], "cached");
    assert.deepEqual(first.body, Buffer.from([0, 255, 128])); assert.deepEqual(second.body, first.body); assert.equal(effects, 1);
  } finally { await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }); }
  console.log(JSON.stringify({ runtime: process.version, installedRedisRoundTrip: "passed", installedRedisHttp500Effects: effects }));
} finally { await client.del([key, httpKey]); await client.close(); }
