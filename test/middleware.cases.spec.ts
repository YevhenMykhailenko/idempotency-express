import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import {
  idempotencyMiddleware,
  MemoryStore,
  type IdemOptions,
} from "../src/index.js";

function makeApp(opts?: Partial<IdemOptions>) {
  const app = express();
  app.use(express.json());
  const store = new MemoryStore();

  app.post(
    "/orders",
    idempotencyMiddleware({
      store,
      replay: { headerWhitelist: ["location"] },
      inFlight: { strategy: "reject" },
      ...(opts || {}),
    }),
    async (req, res) => {
      res.setHeader("Location", "/orders/xyz");
      res.status(201).json({ id: 123, body: req.body });
    }
  );

  return { app, store };
}

describe("middleware — extended cases", () => {
  it("replays content-type and whitelisted headers (location), but never set-cookie", async () => {
    const { app } = makeApp();

    const key = "hdr-1";
    const r1 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r1.headers["content-type"]).toMatch(/application\/json/);
    expect(r1.headers["location"]).toBe("/orders/xyz");

    const r2 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r2.headers["idempotency-status"]).toBe("cached");
    expect(r2.headers["content-type"]).toMatch(/application\/json/);
    expect(r2.headers["location"]).toBe("/orders/xyz");
    expect(r2.headers["set-cookie"]).toBeUndefined();
  });

  it("requireKey=true returns 400 and 'missing-key'", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/orders",
      idempotencyMiddleware({
        store,
        requireKey: true,
      }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const r = await request(app).post("/orders").send({}).expect(400);
    expect(r.headers["idempotency-status"]).toBe("missing-key");
  });

  it("methods filter: GET bypasses middleware (no Idempotency headers)", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();

    app.use(
      idempotencyMiddleware({
        store,
        methods: ["POST"],
      })
    );

    app.get("/ping", (req, res) => res.status(200).json({ pong: true }));

    const r = await request(app).get("/ping").expect(200);
    expect(r.headers["idempotency-status"]).toBeUndefined();
    expect(r.headers["idempotency-key"]).toBeUndefined();
  });

  it("does NOT cache 5xx (second call is not a replay)", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();
    let counter = 0;

    app.post(
      "/unstable",
      idempotencyMiddleware({ store }),
      (req, res) => {
        counter += 1;
        if (counter === 1) {
          return res.status(500).json({ error: "boom" });
        }
        return res.status(201).json({ ok: true });
      }
    );

    const key = "unstable-1";
    const r1 = await request(app)
      .post("/unstable")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(500);
    expect(r1.headers["idempotency-status"]).toBe("created");

    const r2 = await request(app)
      .post("/unstable")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);
    expect(r2.headers["idempotency-status"]).toBe("created");
  });

  it("caches 4xx responses (same payload -> cached)", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/bad",
      idempotencyMiddleware({ store }),
      (req, res) => {
        if (!req.body || req.body.a !== 1) {
          return res.status(400).json({ error: "bad input" });
        }
        return res.status(201).json({ ok: true });
      }
    );

    const key = "bad-1";

    const r1 = await request(app)
      .post("/bad")
      .set("Idempotency-Key", key)
      .send({ a: 2 })
      .expect(400);
    expect(r1.headers["idempotency-status"]).toBe("created");

    const r2 = await request(app)
      .post("/bad")
      .set("Idempotency-Key", key)
      .send({ a: 2 })
      .expect(400);
    expect(r2.headers["idempotency-status"]).toBe("cached");
  });

  it("includeQuery=false (default): query ignored in fingerprint -> replay", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/q",
      idempotencyMiddleware({ store /* default includeQuery=false */ }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const key = "q-1";
    await request(app)
      .post("/q?x=1")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(app)
      .post("/q?x=2")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r2.headers["idempotency-status"]).toBe("cached");
  });

  it("includeQuery=true: different query -> conflict", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/q2",
      idempotencyMiddleware({
        store,
        fingerprint: { includeQuery: true },
      }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const key = "q-2";
    await request(app)
      .post("/q2?x=1")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(app)
      .post("/q2?x=2")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(409);

    expect(r2.headers["idempotency-status"]).toBe("conflict");
  });

  it("custom fingerprint (tenant header) causes conflict when changed", async () => {
    const app = express();
    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/tenant",
      idempotencyMiddleware({
        store,
        fingerprint: {
          custom: (req) => String(req.headers["x-tenant-id"] || ""),
        },
      }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const key = "tenant-1";
    await request(app)
      .post("/tenant")
      .set("Idempotency-Key", key)
      .set("x-tenant-id", "t1")
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(app)
      .post("/tenant")
      .set("Idempotency-Key", key)
      .set("x-tenant-id", "t2")
      .send({ a: 1 })
      .expect(409);

    expect(r2.headers["idempotency-status"]).toBe("conflict");
  });

  it("echoes Idempotency-Key in responses", async () => {
    const { app } = makeApp();
    const key = "echo-1";
    const r1 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);
    expect(r1.headers["idempotency-key"]).toBe(key);

    const r2 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);
    expect(r2.headers["idempotency-key"]).toBe(key);
  });
});
