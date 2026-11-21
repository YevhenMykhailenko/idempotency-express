import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { gunzipSync } from "node:zlib";
import compression from "compression";
import express from "express";
import * as root from "express-idempotency-middleware";
import { RedisStore } from "express-idempotency-middleware/redis";

assert.equal("RedisStore" in root, false);
assert.equal(new RedisStore({ client: { eval: async () => ["missing"] } }).protocolVersion, 3);
const store = new root.MemoryStore();
assert.equal(store.protocolVersion, 3);
for (const name of ["get", "abort", "release"]) assert.equal(name in store, false);
assert.throws(() => root.idempotencyMiddleware({ store, namespace: "package" }));
let effects = 0;
let callbacks = 0;
const app = express();
app.use(compression({ threshold: 0 }));
app.use(express.json());
app.use(root.idempotencyMiddleware({ store, namespace: "package", scope: "public-test" }));
app.post("/orders", (_req, res) => { effects++; res.cookie("session", "not-stored").status(201).json({ id: "one" }); });
app.post("/error", (_req, res) => { effects++; res.status(500).json({ error: "business-failure" }); });
app.post("/binary", (_req, res) => { effects++; res.type("application/octet-stream").end(new Uint8Array([0, 255, 128]), () => { callbacks++; }); });
app.post("/empty", (_req, res) => { effects++; res.status(204).end(() => { callbacks++; }); });
app.post("/gzip", (_req, res) => { effects++; res.type("text").end("hello 界\n".repeat(400), () => { callbacks++; }); });
const server = createServer(app);
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const { port } = server.address();
async function send(path, key, body = { amount: 1 }, extra = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const client = request({ hostname: "127.0.0.1", port, method: "POST", path, agent: false, headers: {
      "Content-Type": "application/json", "Content-Length": String(bytes.length), ...(key ? { "Idempotency-Key": key } : {}), ...extra,
    } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); }); res.once("error", reject);
      res.once("end", () => { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    client.once("error", reject); client.end(bytes);
  });
}
try {
  assert.equal((await send("/orders")).status, 400);
  const first = await send("/orders", "key");
  const second = await send("/orders", "key");
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal(first.headers["idempotency-status"], "created");
  assert.equal(second.headers["idempotency-status"], "cached");
  assert.deepEqual(second.body, first.body); assert.equal(second.headers["set-cookie"], undefined);
  assert.equal((await send("/orders", "key", { amount: 2 })).status, 409);
  const key = "idem:v3:" + createHash("sha256").update(JSON.stringify(["package", "public-test", "key"])).digest("hex");
  const entry = await store.read(key);
  assert.equal(entry.kind, "completed"); assert.ok(Buffer.isBuffer(entry.cached.body));
  assert.equal(entry.cached.headers["set-cookie"], undefined);
  for (const [path, status] of [["/error", 500], ["/binary", 200], ["/empty", 204]]) {
    const original = await send(path, path.slice(1)); const replay = await send(path, path.slice(1));
    assert.equal(original.status, status); assert.equal(replay.status, status);
    assert.equal(replay.headers["idempotency-status"], "cached"); assert.deepEqual(replay.body, original.body);
    if (path === "/binary") assert.deepEqual(original.body, Buffer.from([0, 255, 128]));
    if (path === "/empty") assert.equal(original.body.length, 0);
  }
  for (const encoding of ["gzip", "identity"]) {
    const result = await send("/gzip", "gzip", undefined, { "Accept-Encoding": encoding });
    const bytes = encoding === "gzip" ? gunzipSync(result.body) : result.body;
    assert.equal(bytes.toString(), "hello 界\n".repeat(400));
    assert.equal(result.headers["content-encoding"], encoding === "gzip" ? "gzip" : undefined);
  }
  assert.equal(effects, 5); assert.equal(callbacks, 3);
  console.log(JSON.stringify({ runtime: process.version, express: express.application ? "loaded" : "missing", effects, callbacks, installedPackageSmoke: "passed" }));
} finally { await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }); }
