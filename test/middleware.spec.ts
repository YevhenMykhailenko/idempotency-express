import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import { idempotencyMiddleware, MemoryStore } from "../src/index.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  const store = new MemoryStore();

  app.post(
    "/orders",
    idempotencyMiddleware({
      store,
      replay: { headerWhitelist: ["location"] },
      inFlight: { strategy: "wait", waitTimeoutMs: 1000, pollMs: 50 }
    }),
    async (req, res) => {
      res.setHeader("Location", "/orders/123");
      res.status(201).json({ id: 123 });
    }
  );

  return app;
}

describe("middleware", () => {
  it("replays identical POST", async () => {
    const app = makeApp();

    const key = "abc-123";
    const body = { a: 1 };

    const r1 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);

    expect(r1.headers["idempotency-status"]).toBe("created");
    const r2 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);

    expect(r2.headers["idempotency-status"]).toBe("cached");
    expect(r2.headers["idempotency-replayed"]).toBe("true");
    expect(r2.body).toEqual({ id: 123 });
  });

  it("conflicts on different payload with same key", async () => {
    const app = makeApp();

    const key = "abc-456";

    await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 1 })
      .expect(201);

    const r2 = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ a: 2 })
      .expect(409);

    expect(r2.headers["idempotency-status"]).toBe("conflict");
  });
});
