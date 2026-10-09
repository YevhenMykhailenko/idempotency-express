import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { idempotencyMiddleware, MemoryStore, type IdemOptions } from "../src/index.js";
import { filterHeaders } from "../src/utils/headers.js";

class CountingStore extends MemoryStore {
  commits = 0;

  override async commit(key: string, data: Parameters<MemoryStore["commit"]>[1]): Promise<void> {
    this.commits += 1;
    await super.commit(key, data);
  }
}

class FlakyReadStore extends MemoryStore {
  private failOnce = true;

  override async get(key: string) {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("temporary store failure");
    }
    return super.get(key);
  }
}

describe("middleware lifecycle regressions", () => {
  it("replays an empty 204 response", async () => {
    const app = express();
    const store = new MemoryStore();
    let calls = 0;
    app.post("/empty", idempotencyMiddleware({ store }), (_req, res) => {
      calls += 1;
      res.status(204).end();
    });

    await request(app).post("/empty").set("Idempotency-Key", "empty").expect(204);
    const replay = await request(app).post("/empty")
      .set("Idempotency-Key", "empty").expect(204);
    expect(replay.headers["idempotency-status"]).toBe("cached");
    expect(replay.headers.etag).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("replays bytes from res.end without adding a content type or ETag", async () => {
    const app = express();
    const store = new MemoryStore();
    let calls = 0;
    app.post("/plain", idempotencyMiddleware({ store }), (_req, res) => {
      calls += 1;
      res.status(201).end("plain response");
    });

    const first = await request(app).post("/plain")
      .set("Idempotency-Key", "plain").expect(201);
    const replay = await request(app).post("/plain")
      .set("Idempotency-Key", "plain").expect(201);
    expect(replay.text).toBe(first.text);
    expect(replay.headers["content-type"]).toBeUndefined();
    expect(replay.headers.etag).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("commits a JSON response only once", async () => {
    const app = express();
    const store = new CountingStore();
    app.post("/json", idempotencyMiddleware({ store }), (_req, res) => {
      res.status(201).json({ ok: true });
    });

    await request(app).post("/json").set("Idempotency-Key", "count").expect(201);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.commits).toBe(1);
  });

  it("does not leave a local key lock after a store read error", async () => {
    const app = express();
    const store = new FlakyReadStore();
    app.post("/flaky", idempotencyMiddleware({ store }), (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(503).json({ error: "store unavailable" });
    });

    await request(app).post("/flaky").set("Idempotency-Key", "flaky").expect(503);
    const retry = await request(app).post("/flaky")
      .set("Idempotency-Key", "flaky").expect(201);
    expect(retry.headers["idempotency-status"]).toBe("created");
  });

  it("rejects configuration that would create invalid or unbounded reservations", () => {
    const store = new MemoryStore();
    const invalid: Array<Partial<IdemOptions>> = [
      { ttlMs: 0 },
      { ttlMs: Number.POSITIVE_INFINITY },
      { inFlight: { strategy: "wait", pollMs: 0 } },
      { inFlight: { strategy: "wait", waitTimeoutMs: -1 } },
      { fingerprint: { maxBodyBytes: -1 } },
      { keyHeader: "Invalid Header" },
    ];
    for (const options of invalid) {
      expect(() => idempotencyMiddleware({ store, ...options })).toThrow();
    }
  });

  it("never replays transport or authentication headers, even if whitelisted", () => {
    const headers = {
      "content-type": "application/json",
      "content-encoding": "gzip",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "set-cookie": "session=secret",
      location: "/resource/1",
    };
    expect(filterHeaders(headers, Object.keys(headers))).toEqual({
      "content-type": "application/json",
      location: "/resource/1",
    });
  });

  it("rejects nonempty bodies when mounted before the body parser", async () => {
    const app = express();
    const store = new MemoryStore();
    let calls = 0;
    app.post("/late-parser", idempotencyMiddleware({ store }), express.json(), (_req, res) => {
      calls += 1;
      res.status(201).json({ calls });
    });

    const first = await request(app).post("/late-parser")
      .set("Idempotency-Key", "late").send({ amount: 1 }).expect(400);
    expect(first.headers["idempotency-status"]).toBe("unparsed-body");
    const second = await request(app).post("/late-parser")
      .set("Idempotency-Key", "late").send({ amount: 2 }).expect(400);
    expect(second.headers["idempotency-status"]).toBe("unparsed-body");
    expect(calls).toBe(0);
  });
});
