import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import {
  idempotencyMiddleware,
  MemoryStore,
  type IdemOptions,
} from "../src/index.js";
import { testHttpServer } from "./helpers/test-http-server.js";

async function makeApp(opts?: Partial<IdemOptions>) {
  const app = express();

  app.use(express.json());
  const store = new MemoryStore();

  app.post(
    "/orders",
    idempotencyMiddleware({
      store,
      namespace: "extended-tests",
      scope: "public-test",
      replay: { headerWhitelist: ["location"] },
      inFlight: { strategy: "reject" },
      ...(opts || {}),
    } as IdemOptions),
    async (req, res) => {
      res.setHeader("Location", "/orders/xyz");
      res.status(201).json({ id: 123, body: req.body });
    }
  );

  const http = await testHttpServer(app);

  return { ...http, store };
}

describe("middleware — extended cases", () => {
  it("replays content-type and whitelisted headers (location), but never set-cookie", async () => {
    const { server } = await makeApp();

    const key = "hdr-1";
    const r1 = await request(server)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r1.headers["content-type"]).toMatch(/application\/json/);
    expect(r1.headers["location"]).toBe("/orders/xyz");

    const r2 = await request(server)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r2.headers["idempotency-status"]).toBe("cached");
    expect(r2.headers["content-type"]).toMatch(/application\/json/);
    expect(r2.headers["location"]).toBe("/orders/xyz");
    expect(r2.headers["set-cookie"]).toBeUndefined();
  });

  it("requireKey=true returns 400 and a stable key_required code", async () => {
    const app = express();

    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/orders",
      idempotencyMiddleware({
        store,
        namespace: "extended-tests",
        scope: "public-test",
        requireKey: true,
      }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const { server } = await testHttpServer(app);
    const r = await request(server).post("/orders").send({}).expect(400);

    expect(r.headers["idempotency-status"]).toBe("error");
    expect(r.body.error.code).toBe("idempotency_key_required");
  });

  it("methods filter: GET bypasses middleware (no Idempotency headers)", async () => {
    const app = express();

    app.use(express.json());
    const store = new MemoryStore();

    app.use(
      idempotencyMiddleware({
        store,
        namespace: "extended-tests",
        scope: "public-test",
        methods: ["POST"],
      })
    );

    app.get("/ping", (req, res) => res.status(200).json({ pong: true }));

    const { server } = await testHttpServer(app);
    const r = await request(server).get("/ping").expect(200);

    expect(r.headers["idempotency-status"]).toBeUndefined();
    expect(r.headers["idempotency-key"]).toBeUndefined();
  });

  it("caches a completed 5xx without repeating its business effect", async () => {
    const app = express();

    app.use(express.json());
    const store = new MemoryStore();
    let counter = 0;

    app.post(
      "/unstable",
      idempotencyMiddleware({ store, namespace: "extended-tests", scope: "public-test" }),
      (req, res) => {
        counter += 1;
        if (counter === 1) {
          return res.status(500).json({ error: "boom" });
        }

        return res.status(201).json({ ok: true });
      }
    );

    const { server } = await testHttpServer(app);
    const key = "unstable-1";
    const r1 = await request(server)
      .post("/unstable")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(500);

    expect(r1.headers["idempotency-status"]).toBe("created");

    const r2 = await request(server)
      .post("/unstable")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(500);

    expect(r2.headers["idempotency-status"]).toBe("cached");
    expect(r2.body).toEqual(r1.body);
    expect(counter).toBe(1);
  });

  it("caches 4xx responses (same payload -> cached)", async () => {
    const app = express();

    app.use(express.json());
    const store = new MemoryStore();

    app.post(
      "/bad",
      idempotencyMiddleware({ store, namespace: "extended-tests", scope: "public-test" }),
      (req, res) => {
        if (!req.body || req.body.a !== 1) {
          return res.status(400).json({ error: "bad input" });
        }

        return res.status(201).json({ ok: true });
      }
    );

    const { server } = await testHttpServer(app);
    const key = "bad-1";

    const r1 = await request(server)
      .post("/bad")
      .set("Idempotency-Key", key)
      .send({ a: 2 })
      .expect(400);

    expect(r1.headers["idempotency-status"]).toBe("created");

    const r2 = await request(server)
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
      idempotencyMiddleware({ store, namespace: "extended-tests", scope: "public-test" /* default includeQuery=false */ }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const { server } = await testHttpServer(app);
    const key = "q-1";

    await request(server)
      .post("/q?x=1")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(server)
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
        namespace: "extended-tests",
        scope: "public-test",
        fingerprint: { includeQuery: true },
      }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const { server } = await testHttpServer(app);
    const key = "q-2";

    await request(server)
      .post("/q2?x=1")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(server)
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
        namespace: "extended-tests",
        scope: "public-test",
        fingerprint: {
          custom: (req) => String(req.headers["x-tenant-id"] || ""),
        },
      }),
      (req, res) => res.status(201).json({ ok: true })
    );

    const { server } = await testHttpServer(app);
    const key = "tenant-1";

    await request(server)
      .post("/tenant")
      .set("Idempotency-Key", key)
      .set("x-tenant-id", "t1")
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(server)
      .post("/tenant")
      .set("Idempotency-Key", key)
      .set("x-tenant-id", "t2")
      .send({ a: 1 })
      .expect(409);

    expect(r2.headers["idempotency-status"]).toBe("conflict");
  });

  it("echoes Idempotency-Key in responses", async () => {
    const { server } = await makeApp();
    const key = "echo-1";
    const r1 = await request(server)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r1.headers["idempotency-key"]).toBe(key);

    const r2 = await request(server)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    expect(r2.headers["idempotency-key"]).toBe(key);
  });
});
