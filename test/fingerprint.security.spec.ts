import express from "express";
import type { Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { idempotencyMiddleware, MemoryStore } from "../src/index.js";
import type { FingerprintOptions } from "../src/index.js";
import { buildFingerprint } from "../src/utils/fingerprint.js";

function makeApp(parser: express.RequestHandler, fingerprint?: FingerprintOptions) {
  const app = express();
  app.use(parser);
  let calls = 0;
  app.post(
    "/orders",
    idempotencyMiddleware({ store: new MemoryStore(), fingerprint }),
    (req, res) => res.status(201).json({ call: ++calls, body: req.body })
  );
  return { app, calls: () => calls };
}

describe("security: fingerprint collisions", () => {
  it("keeps distinct unpaired UTF-16 surrogates distinct", () => {
    const req = (body: string) => ({ method: "POST", originalUrl: "/orders", body }) as Request;
    expect(buildFingerprint(req("\ud800"))).not.toBe(buildFingerprint(req("\udc00")));
  });

  it("fails closed for non-JSON object bodies", () => {
    const req = { method: "POST", originalUrl: "/orders", body: new Date() } as Request;
    expect(() => buildFingerprint(req)).toThrow("plain JSON object");
    const shared = { id: 1 };
    const aliased = { method: "POST", originalUrl: "/orders", body: { a: shared, b: shared } } as Request;
    expect(() => buildFingerprint(aliased)).toThrow("Shared or circular request body");
  });

  it("rejects bodies beyond the default limit without claiming the key", async () => {
    const { app, calls } = makeApp(express.json());
    const pad = "x".repeat(65_536);
    const oversized = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "large-default")
      .send({ pad, zzz: "FIRST" })
      .expect(413);
    expect(oversized.headers["idempotency-status"]).toBe("too-large");
    expect(calls()).toBe(0);

    const accepted = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "large-default")
      .send({ zzz: "SMALL" })
      .expect(201);
    expect(accepted.headers["idempotency-status"]).toBe("created");
    expect(calls()).toBe(1);
  });

  it("checks the entire body when the configured limit allows it", async () => {
    const { app, calls } = makeApp(express.json(), { maxBodyBytes: 100 * 1024 });
    const pad = "x".repeat(65_536);
    const key = "large-allowed";
    await request(app).post("/orders").set("Idempotency-Key", key)
      .send({ pad, zzz: "ORDER-100" }).expect(201);
    const changed = await request(app).post("/orders").set("Idempotency-Key", key)
      .send({ pad, zzz: "ORDER-999" }).expect(409);
    expect(changed.headers["idempotency-status"]).toBe("conflict");
    expect(calls()).toBe(1);
    const same = await request(app).post("/orders").set("Idempotency-Key", key)
      .send({ pad, zzz: "ORDER-100" }).expect(201);
    expect(same.headers["idempotency-status"]).toBe("cached");
  });

  it("keeps __proto__ as a real JSON key", async () => {
    const { app, calls } = makeApp(express.json());
    const key = "proto";
    await request(app).post("/orders").set("Idempotency-Key", key).send({}).expect(201);
    const changed = await request(app).post("/orders").set("Idempotency-Key", key)
      .set("Content-Type", "application/json")
      .send('{"__proto__":{"admin":true}}').expect(409);
    expect(changed.headers["idempotency-status"]).toBe("conflict");
    expect(calls()).toBe(1);
  });

  it("does not trim string values in JSON objects", async () => {
    const { app } = makeApp(express.json());
    const key = "space";
    await request(app).post("/orders").set("Idempotency-Key", key)
      .send({ note: "pay now" }).expect(201);
    await request(app).post("/orders").set("Idempotency-Key", key)
      .send({ note: "  pay now  " }).expect(409);
  });

  it("distinguishes negative zero from zero in parsed JSON", async () => {
    const { app } = makeApp(express.json());
    const key = "negative-zero";
    await request(app).post("/orders").set("Idempotency-Key", key)
      .set("Content-Type", "application/json").send('{"amount":-0}').expect(201);
    await request(app).post("/orders").set("Idempotency-Key", key)
      .set("Content-Type", "application/json").send('{"amount":0}').expect(409);
  });

  it("separates custom values from raw string bodies", async () => {
    const { app, calls } = makeApp(express.text(), {
      custom: (req) => req.get("X-Scope"),
    });
    const key = "delimiter";
    await request(app).post("/orders").set("Idempotency-Key", key)
      .set("Content-Type", "text/plain").send('A|{"amount":100}').expect(201);
    const changed = await request(app).post("/orders").set("Idempotency-Key", key)
      .set("X-Scope", "A").set("Content-Type", "text/plain")
      .send('{"amount":100}').expect(409);
    expect(changed.headers["idempotency-status"]).toBe("conflict");
    expect(calls()).toBe(1);
  });

  it("hashes raw Buffer bytes without lossy UTF-8 decoding", async () => {
    const { app, calls } = makeApp(express.raw());
    const key = "raw";
    await request(app).post("/orders").set("Idempotency-Key", key)
      .set("Content-Type", "application/octet-stream").send(Buffer.from([0xff])).expect(201);
    const changed = await request(app).post("/orders").set("Idempotency-Key", key)
      .set("Content-Type", "application/octet-stream").send(Buffer.from([0xfe])).expect(409);
    expect(changed.headers["idempotency-status"]).toBe("conflict");
    expect(calls()).toBe(1);
  });

  it("measures UTF-8 bytes rather than UTF-16 string length", async () => {
    const { app, calls } = makeApp(express.text(), { maxBodyBytes: 10 });
    const response = await request(app).post("/orders").set("Idempotency-Key", "unicode")
      .set("Content-Type", "text/plain").send("界".repeat(4)).expect(413);
    expect(response.headers["idempotency-status"]).toBe("too-large");
    expect(calls()).toBe(0);
  });

  it("distinguishes parsed query arrays from comma-separated strings", async () => {
    const { app } = makeApp(express.json(), { includeQuery: true });
    const key = "query-shape";
    await request(app).post("/orders?x=1&x=2").set("Idempotency-Key", key)
      .send({}).expect(201);
    await request(app).post("/orders?x=1%2C2").set("Idempotency-Key", key)
      .send({}).expect(409);
  });

  it("preserves canonical object and query ordering for true replays", async () => {
    const { app } = makeApp(express.json(), { includeQuery: true });
    const key = "canonical";
    await request(app).post("/orders?a=1&b=2").set("Idempotency-Key", key)
      .send({ z: 1, a: { y: 2, x: 3 } }).expect(201);
    const replay = await request(app).post("/orders?b=2&a=1")
      .set("Idempotency-Key", key).send({ a: { x: 3, y: 2 }, z: 1 }).expect(201);
    expect(replay.headers["idempotency-status"]).toBe("cached");
  });
});
