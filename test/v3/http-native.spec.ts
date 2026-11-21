import compression from "compression";
import express from "express";
import type { Response } from "express";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { idempotencyMiddleware, MemoryStore, type CachedResponse, type CommitResult } from "../../src/index.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { createHttpApp, deferred, httpOptions } from "../helpers/http-app.js";
import { serve } from "../helpers/native-http.js";

const physicalKey = buildStorageKey("http-v3-tests", "public-test", "key");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

async function listen(app: express.Express) {
  const http = await serve(app);

  cleanup.push(http.close);

  return http;
}

describe("v3 native header extraction", () => {
  it.each([
    ["Idempotency-Key", "same", "Idempotency-Key", "same"],
    ["Idempotency-Key", "first", "idempotency-key", "second"],
    ["X-Operation", "same", "x-operation", "same"],
  ])("KEY-02: rejects raw duplicate headers %j", async (...headers) => {
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const api = createHttpApp({ store, keyHeader: headers[0] });
    const http = await listen(api.app);
    const result = await http.send({ headers: ["Host", "localhost", "Content-Length", "0", ...headers] }).result;

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body.toString()).error.code).toBe("idempotency_key_invalid");
    expect(result.headers["idempotency-key"]).toBeUndefined();
    expect(begin).not.toHaveBeenCalled();
    expect(api.counters.calls).toBe(0);
  });
});

describe("v3 buffered Node and Express APIs", () => {
  type EndCase = { name: string; body: Buffer; status?: number; send: (res: Response, callback: () => void) => unknown; callback?: boolean };
  const cases: EndCase[] = [
    { name: "end()", body: Buffer.alloc(0), send: (res) => res.end() },
    { name: "end(callback)", body: Buffer.alloc(0), callback: true, send: (res, cb) => res.end(cb) },
    { name: "end(string, callback)", body: Buffer.from("界é"), callback: true, send: (res, cb) => res.end("界é", cb) },
    { name: "end(string, encoding, callback)", body: Buffer.from([0xe9]), callback: true, send: (res, cb) => res.end("é", "latin1", cb) },
    { name: "end(Buffer, callback)", body: Buffer.from([0, 0xff, 0x80, 1]), callback: true, send: (res, cb) => res.end(Buffer.from([0, 0xff, 0x80, 1]), cb) },
    { name: "end(Uint8Array, callback)", body: Buffer.from([0, 255, 7]), callback: true, send: (res, cb) => res.end(new Uint8Array([0, 255, 7]), cb) },
    { name: "end(empty Buffer, callback)", body: Buffer.alloc(0), callback: true, send: (res, cb) => res.end(Buffer.alloc(0), cb) },
    { name: "send(string)", body: Buffer.from("hello 界"), send: (res) => res.send("hello 界") },
    { name: "send(Buffer)", body: Buffer.from([0, 0xfe, 4]), send: (res) => res.send(Buffer.from([0, 0xfe, 4])) },
    { name: "json", body: Buffer.from('{"ok":true}'), send: (res) => res.json({ ok: true }) },
    ...[204, 205, 304].map((status): EndCase => ({ name: `empty ${status}`, status, body: Buffer.alloc(0), callback: true, send: (res, cb) => res.end(cb) })),
  ];

  it.each(cases)("HTTP-03/HTTP-18: $name preserves bytes and delays finish/callback until ACK", async (test) => {
    const entered = deferred();
    const ack = deferred();
    const order: string[] = [];

    class SlowStore extends MemoryStore {
      commits = 0;
      override async commit(key: string, data: CachedResponse, owner: string): Promise<CommitResult> {
        this.commits++; entered.resolve(); await ack.promise;
        const result = await super.commit(key, data, owner);

        order.push("ack");

        return result;
      }
    }

    const store = new SlowStore();
    let synchronousReturn: unknown;
    let response: Response | undefined;
    const callback = vi.fn(() => { order.push("callback"); });
    const api = createHttpApp({ store }, (_req, res) => {
      response = res;
      res.status(test.status ?? 201);
      res.once("finish", () => { order.push("finish"); });
      synchronousReturn = test.send(res, callback);
      res.end("duplicate");
    });
    const http = await listen(api.app);
    let clientFinished = false;
    const pending = http.send().result.then((result) => { clientFinished = true;

      return result; });

    await entered.promise;
    expect(synchronousReturn).toBe(response);
    expect(response?.writableEnded).toBe(false);
    expect(response?.headersSent).toBe(false);
    expect(order).toEqual([]);
    expect(clientFinished).toBe(false);
    ack.resolve();
    const first = await pending;

    expect(first.status).toBe(test.status ?? 201);
    expect(first.body).toEqual(test.body);
    expect(order).toEqual(test.callback ? ["ack", "finish", "callback"] : ["ack", "finish"]);
    const second = await http.send().result;

    expect(second.body).toEqual(first.body);
    expect(second.status).toBe(first.status);
    expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(second.headers["etag"]).toBeUndefined();
    expect(second.headers["idempotency-status"]).toBe("cached");
    expect(callback).toHaveBeenCalledTimes(test.callback ? 1 : 0);
    expect(store.commits).toBe(1);
    expect(api.counters.effects).toBe(1);
  });

  it("HTTP-18: snapshots mutable bytes before commit yields and seals a later Express error response", async () => {
    const gate = deferred();
    const entered = deferred();

    class SlowStore extends MemoryStore {
      override async commit(key: string, data: CachedResponse, owner: string) {
        entered.resolve(); await gate.promise;

        return super.commit(key, data, owner);
      }
    }

    const api = createHttpApp({ store: new SlowStore() }, (_req, res, next) => {
      const body = Buffer.from("first");

      res.status(201).end(body);
      body.fill(0);
      next(new Error("late error"));
    });

    api.app.use((_error: Error, _req: express.Request, res: Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "must not replace the sealed result" });
    });
    const http = await listen(api.app);
    const pending = http.send().result;

    await entered.promise; gate.resolve();
    const result = await pending;

    expect(result.status).toBe(201);
    expect(result.body.toString()).toBe("first");
    expect((await http.send().result).body).toEqual(result.body);
  });

  it("HTTP-04: a completed centralized Express error response is replayed, not mistaken for a commit fault", async () => {
    const api = createHttpApp({}, (_req, _res, next) => { next(new Error("business failure")); });

    api.app.use((_error: Error, _req: express.Request, res: Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "business failure" });
    });
    const http = await listen(api.app);
    const first = await http.send().result;
    const second = await http.send().result;

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(first.body).toEqual(second.body);
    expect(second.headers["idempotency-status"]).toBe("cached");
    expect(api.counters.effects).toBe(1);
  });

  it.each(["write", "pipe", "flushHeaders", "writeHead"])("HTTP-17: native %s cannot leak the first application bytes", async (action) => {
    const store = new MemoryStore();
    const commit = vi.spyOn(store, "commit");
    const api = createHttpApp({ store }, (_req, res) => {
      if (action === "write") { res.write("partial-secret"); res.end("tail"); }
      else if (action === "pipe") Readable.from(["partial-secret", "tail"]).pipe(res);
      else if (action === "flushHeaders") { res.flushHeaders(); res.end("partial-secret"); }
      else { res.writeHead(201, { "X-Secret": "partial-secret" }); res.end("partial-secret"); }
    });
    const http = await listen(api.app);
    const result = await http.send().result;

    expect(result.status).toBe(503);
    expect(JSON.parse(result.body.toString()).error.code).toBe("idempotency_response_unsupported");
    expect(result.body.toString()).not.toContain("partial-secret");
    expect(result.headers["x-secret"]).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect((await store.read(physicalKey))?.kind).toBe("inflight");
  });

  it("HTTP-08: fault finishes its end callback once, strips handler headers and preserves baseline CORS/security", async () => {
    const entered = deferred();
    const ack = deferred();

    class FailingStore extends MemoryStore {
      commits = 0;
      override async commit(): Promise<CommitResult> { this.commits++; entered.resolve(); await ack.promise;

        throw new Error("unavailable"); }
    }

    const store = new FailingStore();
    const app = express();

    app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "https://example.com");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Set-Cookie", "baseline=secret");
      res.setHeader("WWW-Authenticate", "baseline-secret");
      res.setHeader("Content-Disposition", "attachment; filename=wrong.txt");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      next();
    });
    const callback = vi.fn();

    app.post("/orders", idempotencyMiddleware(httpOptions({ store })), (_req, res) => {
      res.set({ "Set-Cookie": "handler=secret", Location: "/wrong", ETag: '"wrong"', "Content-Length": "10000", "X-Handler": "wrong" });
      res.status(201).end("candidate", callback);
    });
    const http = await listen(app);
    const pending = http.send().result;

    await entered.promise;
    expect(callback).not.toHaveBeenCalled();
    ack.resolve();
    const result = await pending;

    expect(result.status).toBe(503);
    expect(JSON.parse(result.body.toString()).error.code).toBe("idempotency_result_unknown");
    expect(result.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["content-security-policy"]).toBe("default-src 'none'");
    for (const header of ["set-cookie", "www-authenticate", "location", "etag", "content-encoding", "content-disposition", "x-handler"]) expect(result.headers[header]).toBeUndefined();

    expect(result.headers["content-length"]).not.toBe("10000");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(store.commits).toBe(1);
    expect((await store.read(physicalKey))?.kind).toBe("inflight");
  });
});

describe("v3 compression before capture", () => {
  it.each(["gzip", "identity"])("stores uncompressed bytes and independently negotiates replay (first=%s)", async (firstEncoding) => {
    const app = express();

    app.use(compression({ threshold: 0 }));
    const store = new MemoryStore();
    const body = Buffer.from("hello 界\n".repeat(400));
    const callback = vi.fn();
    let effects = 0;

    app.post("/orders", idempotencyMiddleware(httpOptions({ store })), (_req, res) => {
      effects++;
      res.type("text").status(201).end(body, callback);
    });
    const http = await listen(app);

    for (const encoding of [firstEncoding, "gzip", "identity"]) {
      const result = await http.send({ headers: { "Idempotency-Key": "key", "Accept-Encoding": encoding } }).result;

      expect(result.status).toBe(201);
      expect(result.headers["vary"]).toContain("Accept-Encoding");
      if (encoding === "gzip") {
        expect(result.headers["content-encoding"]).toBe("gzip");
        expect(gunzipSync(result.body)).toEqual(body);
      } else {
        expect(result.headers["content-encoding"]).toBeUndefined();
        expect(result.body).toEqual(body);
      }
    }

    const entry = await store.read(physicalKey);

    if (entry?.kind !== "completed") throw new Error("Expected completed result");

    expect(entry.cached.body).toEqual(body);
    expect(entry.cached.headers).toEqual({ "content-type": "text/plain; charset=utf-8" });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(effects).toBe(1);
  });

  it("gzip respects commit ACK and end callback ordering", async () => {
    const app = express();

    app.use(compression({ threshold: 0 }));
    const entered = deferred();
    const ack = deferred();
    const order: string[] = [];

    class SlowStore extends MemoryStore {
      override async commit(key: string, data: CachedResponse, owner: string) {
        entered.resolve(); await ack.promise;
        const result = await super.commit(key, data, owner);

        order.push("ack");

        return result;
      }
    }

    app.post("/orders", idempotencyMiddleware(httpOptions({ store: new SlowStore() })), (_req, res) => {
      res.once("finish", () => { order.push("finish"); });
      res.type("text").end("hello".repeat(400), () => { order.push("callback"); });
    });
    const http = await listen(app);
    const pending = http.send({ headers: { "Idempotency-Key": "key", "Accept-Encoding": "gzip" } }).result;

    await entered.promise;
    expect(order).toEqual([]);
    ack.resolve();
    const result = await pending;

    expect(gunzipSync(result.body).toString()).toBe("hello".repeat(400));
    expect(order).toEqual(["ack", "finish", "callback"]);
  });

  it("compresses the technical fault without caching it or leaking the candidate", async () => {
    const app = express();

    app.use(compression({ threshold: 0 }));

    class FailingStore extends MemoryStore { override async commit(): Promise<CommitResult> { throw new Error("fail"); } }

    const store = new FailingStore();
    const callback = vi.fn();

    app.post("/orders", idempotencyMiddleware(httpOptions({ store })), (_req, res) => {
      res.type("text").setHeader("Set-Cookie", "secret=value");
      res.status(201).end("candidate".repeat(400), callback);
    });
    const http = await listen(app);
    const result = await http.send({ headers: { "Idempotency-Key": "key", "Accept-Encoding": "gzip" } }).result;

    expect(result.status).toBe(503);
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(result.body).toString()).error.code).toBe("idempotency_result_unknown");
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await store.read(physicalKey))?.kind).toBe("inflight");
  });
});

describe("v3 disconnects without release", () => {
  it("does not start a handler if the owner disconnects during begin", async () => {
    const entered = deferred();
    const gate = deferred();
    const settled = deferred();
    const closed = deferred();

    class SlowBeginStore extends MemoryStore {
      override async begin(key: string, fp: string, ttl: number) {
        const result = await super.begin(key, fp, ttl);

        entered.resolve(); await gate.promise;
        settled.resolve();

        return result;
      }
    }

    const store = new SlowBeginStore();
    const api = createHttpApp({ store });
    // Track close before the route, while its asynchronous begin is pending.
    const app = express();

    app.use((_req, res, next) => { res.once("close", () => { closed.resolve(); }); next(); });
    app.use(api.app);
    const http = await listen(app);
    const pending = http.send();
    const disconnected = pending.result.catch(() => undefined);

    await entered.promise;
    pending.client.destroy();
    await closed.promise; await disconnected;
    gate.resolve(); await settled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(api.counters.calls).toBe(0);
    expect((await store.read(physicalKey))?.kind).toBe("inflight");
  });

  it("HTTP-13: commits a late handler completion after owner disconnect without transport writes", async () => {
    const started = deferred();
    const closed = deferred();
    const committed = deferred();
    const store = new MemoryStore();
    let response!: Response;
    const api = createHttpApp({ store, onEvent: (event) => { if (event.type === "completed") committed.resolve(); } }, (_req, res) => {
      response = res;
      res.once("close", () => { closed.resolve(); });
      started.resolve();
    });
    const http = await listen(api.app);
    const pending = http.send();
    const disconnected = pending.result.catch(() => undefined);

    await started.promise;
    pending.client.destroy();
    await closed.promise; await disconnected;
    expect(response.destroyed).toBe(true);
    expect((await store.read(physicalKey))?.kind).toBe("inflight");
    const write = vi.spyOn(response.socket!, "write");

    response.status(201).end("late completed");
    await committed.promise;
    const retry = await http.send().result;

    expect(retry.status).toBe(201);
    expect(retry.body.toString()).toBe("late completed");
    expect(retry.headers["idempotency-status"]).toBe("cached");
    expect(write).not.toHaveBeenCalled();
    expect(api.counters.effects).toBe(1);
  });

  it("HTTP-12: transport loss immediately after ACK preserves the completed result", async () => {
    const committed = deferred();
    let response!: Response;
    const api = createHttpApp({ onEvent: (event) => {
      if (event.type === "completed") { response.destroy(); committed.resolve(); }
    } }, (_req, res) => { response = res; res.status(201).end("committed"); });
    const http = await listen(api.app);
    const pending = http.send().result.catch(() => undefined);

    await committed.promise;
    expect(await pending).toBeUndefined();
    const retry = await http.send().result;

    expect(retry.status).toBe(201);
    expect(retry.body.toString()).toBe("committed");
    expect(retry.headers["idempotency-status"]).toBe("cached");
    expect(api.counters.effects).toBe(1);
  });

  it.each(["resolve", "reject"])("WAIT-07: stops a disconnected waiter during a pending read (late %s)", async (outcome) => {
    const ownerStarted = deferred();
    const reading = deferred();
    const readGate = deferred();
    const waiterClosed = deferred();
    const store = new MemoryStore();
    const originalRead = store.read.bind(store);
    let reads = 0;

    vi.spyOn(store, "read").mockImplementation(async (key) => {
      reads++; reading.resolve(); await readGate.promise;
      if (outcome === "reject") throw new Error("late read rejection");

      return originalRead(key);
    });
    let owner!: Response;
    const app = express();
    let requests = 0;

    app.use((_req, res, next) => {
      if (++requests === 2) res.once("close", () => { waiterClosed.resolve(); });

      next();
    });
    app.post("/orders", idempotencyMiddleware(httpOptions({ store, inFlight: { strategy: "wait", pollMs: 2, waitTimeoutMs: 1000 } })), (_req, res) => {
      owner = res; ownerStarted.resolve();
    });
    const http = await listen(app);
    const ownerRequest = http.send().result;

    await ownerStarted.promise;
    const waiter = http.send();
    const disconnected = waiter.result.catch(() => undefined);

    await reading.promise;
    const ownerFinished = finished(owner); // The owner must remain live while the waiter leaves.

    waiter.client.destroy();
    await waiterClosed.promise; await disconnected;
    const before = await originalRead(physicalKey);

    expect(before?.kind).toBe("inflight");
    readGate.resolve();
    // Complete the owner; another poll/claim by the disconnected waiter would be visible in counts/events.
    owner.status(201).end("owner-result");
    await ownerFinished;
    expect((await ownerRequest).status).toBe(201);
    const after = await originalRead(physicalKey);

    expect(after?.kind).toBe("completed");
    expect(after?.reservationId).toBe(before?.reservationId);
    expect(reads).toBe(1);
    expect(requests).toBe(2);
  });

  it("WAIT-07: cancels the polling sleep and local deadline timers on disconnect", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const read = deferred();
    const closed = deferred();
    const owner = { reservationId: "owner", expiresAt: Date.now() + 60_000 };
    let fingerprint = "";
    const begin = vi.fn(async (_key: string, fp: string) => { fingerprint = fp;

      return { kind: "inflight" as const, ...owner }; });
    const app = express();

    app.use((_req, res, next) => { res.once("close", () => { closed.resolve(); }); next(); });
    const get = vi.fn(async () => { read.resolve();

      return { kind: "inflight" as const, fingerprint, ...owner }; });

    app.post("/orders", idempotencyMiddleware(httpOptions({
      store: { protocolVersion: 3, begin, read: get, commit: async () => { throw new Error("no commit"); } },
      inFlight: { strategy: "wait", pollMs: 1000, waitTimeoutMs: 5000 },
    })), (_req, res) => { res.end("must not run"); });
    const http = await listen(app);
    const pending = http.send();
    const disconnected = pending.result.catch(() => undefined);

    await read.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sleepIndex = timers.mock.calls.findIndex(([, delay]) => delay === 1000);
    const deadlineIndex = timers.mock.calls.findIndex(([, delay]) => delay === 2_147_483_647);

    expect(sleepIndex).toBeGreaterThanOrEqual(0);
    expect(deadlineIndex).toBeGreaterThanOrEqual(0);
    pending.client.destroy();
    await closed.promise; await disconnected;
    expect(clear).toHaveBeenCalledWith(timers.mock.results[sleepIndex].value);
    expect(clear).toHaveBeenCalledWith(timers.mock.results[deadlineIndex].value);
    expect(get).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
  });
});
