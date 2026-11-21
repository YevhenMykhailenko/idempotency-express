import type { Request, Response } from "express";
import { performance } from "node:perf_hooks";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { idempotencyMiddleware, MemoryStore, StoreCapacityError, StoreDataError, type BeginResult, type CachedResponse, type CommitResult, type IdemOptions, type Store, type StoreEntry } from "../../src/index.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { deferred, httpOptions, makeHttpApp } from "../helpers/http-app.js";

const physicalKey = (key = "key") => buildStorageKey("http-v3-tests", "public-test", key);

afterEach(() => { vi.restoreAllMocks(); });

describe("v3 request validation", () => {
  it.each([
    { namespace: undefined }, { namespace: "bad name" }, { scope: undefined }, { scope: "" },
    { scope: "x\n" }, { store: {} }, { store: { protocolVersion: 2 } },
    { getKey: 42 }, { requireKey: null }, { onEvent: "logger" },
    { keyHeader: "invalid header" }, { methods: [] }, { methods: ["bad method"] },
    { inFlight: null }, { inFlight: { strategy: "automatic" } },
    { fingerprint: null }, { fingerprint: { custom: "hash" } }, { fingerprint: { includeQuery: "yes" } },
    { replay: null }, { replay: { headerWhitelist: "location" } }, { replay: { headerWhitelist: ["bad header"] } },
    { getKey: () => "key", keyHeader: "Idempotency-Key" },
  ])("CFG-01/CFG-03: rejects invalid configuration %j", (overrides) => {
    expect(() => idempotencyMiddleware(httpOptions(overrides as Partial<IdemOptions>))).toThrow(TypeError);
  });

  it.each([
    { ttlMs: 0 }, { ttlMs: Infinity }, { ttlMs: 1.5 }, { storeTimeoutMs: 0 }, { storeTimeoutMs: 2_147_483_648 },
    { maxResponseBytes: -1 }, { maxResponseBytes: 1_048_577 }, { fingerprint: { maxBodyBytes: -1 } },
    { inFlight: { strategy: "wait", pollMs: 0 } }, { inFlight: { strategy: "wait", waitTimeoutMs: 0 } },
    { inFlight: { strategy: "wait", pollMs: 20, waitTimeoutMs: 10 } },
  ])("CFG-02: rejects invalid limits %j", (overrides) => {
    expect(() => idempotencyMiddleware(httpOptions(overrides as Partial<IdemOptions>))).toThrow(RangeError);
  });

  it("does not invoke request callbacks at construction", () => {
    const scope = vi.fn(() => "user");
    const getKey = vi.fn(() => "key");
    const custom = vi.fn(() => "input");
    const onEvent = vi.fn();

    idempotencyMiddleware(httpOptions({ scope, getKey, fingerprint: { custom }, onEvent }));
    for (const callback of [scope, getKey, custom, onEvent]) expect(callback).not.toHaveBeenCalled();
  });

  it("CFG-05: requires a key by default without calling the Store", async () => {
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const { server, counters } = await makeHttpApp({ store });
    const result = await request(server).post("/orders").send({});

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("idempotency_key_required");
    expect(result.headers["idempotency-key"]).toBeUndefined();
    expect(begin).not.toHaveBeenCalled();
    expect(counters.calls).toBe(0);
  });

  it("CFG-04/CFG-06: bypasses non-selected methods and explicit missing-key opt-out", async () => {
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const scope = vi.fn(() => { throw new Error("must not run"); });
    const { app, server, counters } = await makeHttpApp({ store, scope, requireKey: false });

    app.get("/ping", idempotencyMiddleware(httpOptions({ store, scope, getKey: () => { throw new Error("must not run"); } })), (_req, res) => res.end("pong"));
    expect((await request(server).get("/ping")).text).toBe("pong");
    const result = await request(server).post("/orders").send({});

    expect(result.status).toBe(201);
    expect(result.headers["idempotency-status"]).toBeUndefined();
    expect(counters.calls).toBe(1);
    expect(scope).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it.each(["", "white space", '"quoted"', "a,b", "key\n", "é", "k".repeat(256)])("KEY-01: rejects malformed extracted keys %j", async (key) => {
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const api = await makeHttpApp({ store, getKey: () => key });
    const result = await api.send();

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("idempotency_key_invalid");
    expect(begin).not.toHaveBeenCalled();
    expect(api.counters.calls).toBe(0);
  });

  it.each([
    ["null", (): unknown => null], ["number", (): unknown => 42], ["object", (): unknown => ({})],
    ["resolved Promise", () => Promise.resolve("key")],
    ["rejected Promise", () => Promise.reject(new Error("private extractor error"))],
    ["throw", () => { throw new Error("private extractor error"); }],
  ] as const)("KEY-05: rejects %s extractor results without leaking errors", async (_name, getKey) => {
    const api = await makeHttpApp({ getKey: getKey as unknown as (req: Request) => string });
    const result = await api.send();

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe("idempotency_extractor_failed");
    expect(result.text).not.toContain("private extractor error");
    expect(api.counters.calls).toBe(0);
  });

  it("KEY-03/KEY-04: uses one custom extraction with no header fallback", async () => {
    const getKey = vi.fn((req: Request) => (req.body as { eventId?: string }).eventId);
    const api = await makeHttpApp({ getKey });
    const missing = await api.send();

    expect(missing.status).toBe(400);
    expect(getKey).toHaveBeenCalledTimes(1);
    const first = await request(api.server).post("/orders").set("Idempotency-Key", "ignored").send({ eventId: "evt_123" });
    const second = await request(api.server).post("/orders").set("Idempotency-Key", "another").send({ eventId: "evt_123" });

    expect(first.status).toBe(201);
    expect(second.headers["idempotency-status"]).toBe("cached");
    expect(second.headers["idempotency-key"]).toBe("evt_123");
    expect(api.counters.calls).toBe(1);
  });

  it.each([undefined, null, "", "\t", "x\u007f", "界".repeat(342), Promise.resolve("user")])("KEY-06: rejects invalid runtime scope %j without fallback", async (value) => {
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const api = await makeHttpApp({ store, scope: (() => value) as unknown as (req: Request) => string });
    const result = await api.send();

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe("idempotency_scope_invalid");
    expect(begin).not.toHaveBeenCalled();
  });

  it("observes rejected async scope/fingerprint callbacks without executing the handler", async () => {
    const scope = await makeHttpApp({ scope: (() => Promise.reject(new Error("private"))) as unknown as (req: Request) => string });

    expect((await scope.send()).body.error.code).toBe("idempotency_scope_invalid");
    const fingerprint = await makeHttpApp({ fingerprint: { custom: (() => Promise.reject(new Error("private"))) as unknown as (req: Request) => string } });

    expect((await fingerprint.send()).body.error.code).toBe("idempotency_fingerprint_failed");
    expect(scope.counters.calls + fingerprint.counters.calls).toBe(0);
  });
});

describe("v3 Store failures and response lifecycle", () => {
  it.each([
    ["exception", new Error("private backend URL"), "store_unavailable"],
    ["capacity", new StoreCapacityError(), "capacity_exceeded"],
    ["protocol error", new StoreDataError(), "store_invalid"],
  ] as const)("HTTP-06: fails closed on a begin %s", async (_name, error, code) => {
    class FailingStore extends MemoryStore { override async begin(): Promise<BeginResult> { throw error; } }

    const api = await makeHttpApp({ store: new FailingStore() });
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe(`idempotency_${code}`);
    expect(result.text).not.toContain("private backend URL");
    expect(api.counters.calls).toBe(0);
  });

  it.each(["resolve", "reject"])("HTTP-06: a timed out begin can %s late but never starts the handler", async (outcome) => {
    const gate = deferred();
    const done = deferred();

    class LateBeginStore extends MemoryStore {
      calls = 0;
      override async begin(key: string, fp: string, ttl: number) {
        const result = await super.begin(key, fp, ttl);

        if (++this.calls === 1) {
          await gate.promise;
          try {
            if (outcome === "reject") throw new Error("late begin failure");

            return result;
          } finally { done.resolve(); }
        }

        return result;
      }
    }

    const store = new LateBeginStore();
    const api = await makeHttpApp({ store, storeTimeoutMs: 20 });
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("idempotency_store_unavailable");
    expect((await store.read(physicalKey()))?.kind).toBe("inflight");
    gate.resolve(); await done.promise;
    expect((await api.send()).status).toBe(409);
    expect(api.counters.calls).toBe(0);
  });

  it("Store capacity fails a new HTTP claim without evicting a completed result", async () => {
    const store = new MemoryStore({ maxEntries: 1 });
    const api = await makeHttpApp({ store });

    expect((await api.send()).status).toBe(201);
    const before = await store.read(physicalKey());

    expect((await api.send("another")).body.error.code).toBe("idempotency_capacity_exceeded");
    expect((await api.send()).headers["idempotency-status"]).toBe("cached");
    expect(await store.read(physicalKey())).toEqual(before);
    expect(api.counters.effects).toBe(1);
  });

  it.each([400, 429, 302])("HTTP-05: preserves a completed %s instead of releasing its reservation", async (status) => {
    const api = await makeHttpApp({ replay: { headerWhitelist: ["location"] } }, (_req, res) => {
      res.location("/status/one").status(status).send("original");
    });
    const first = await api.send();
    const second = await api.send();

    expect(first.status).toBe(status);
    expect(second.status).toBe(status);
    expect(second.text).toBe(first.text);
    expect(second.headers["location"]).toBe("/status/one");
    expect(second.headers["idempotency-status"]).toBe("cached");
    expect(api.counters.effects).toBe(1);
  });

  it("HTTP-01: 100 concurrent HTTP requests execute one business effect", async () => {
    const allClaims = deferred();
    const work = deferred();

    class ConcurrentStore extends MemoryStore {
      claims = 0;
      commits = 0;
      override async begin(key: string, fp: string, ttl: number) {
        const result = await super.begin(key, fp, ttl);

        if (++this.claims === 100) allClaims.resolve();

        return result;
      }

      override async commit(key: string, data: CachedResponse, owner: string) {
        this.commits++;

        return super.commit(key, data, owner);
      }
    }

    const store = new ConcurrentStore();
    const api = await makeHttpApp({ store, inFlight: { strategy: "wait", pollMs: 5, waitTimeoutMs: 2_000 } }, (_req, res) => {
      void work.promise.then(() => res.status(201).json({ id: "one" }));
    });
    const pending = Array.from({ length: 100 }, () => api.send().then((result) => result));

    await allClaims.promise;
    work.resolve();
    const results = await Promise.all(pending);

    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(results.every((result) => result.text === results[0].text)).toBe(true);
    expect(results.filter((result) => result.headers["idempotency-status"] === "created")).toHaveLength(1);
    expect(results.filter((result) => result.headers["idempotency-status"] === "cached")).toHaveLength(99);
    expect(api.counters).toEqual({ calls: 1, effects: 1 });
    expect(store.commits).toBe(1);
  });

  it("HTTP-02: rejects a duplicate of a gated owner without changing its reservation", async () => {
    const entered = deferred();
    const gate = deferred();
    const store = new MemoryStore();
    const api = await makeHttpApp({ store }, (_req, res) => {
      entered.resolve();
      void gate.promise.then(() => res.status(201).end("one"));
    });
    const first = api.send().then((result) => result);

    await entered.promise;
    const before = await store.read(physicalKey());
    const duplicate = await api.send();

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({ code: "idempotency_inflight", outcome: "unknown" });
    expect(duplicate.headers["retry-after"]).toBe("1");
    expect(await store.read(physicalKey())).toEqual(before);
    gate.resolve(); await first;
    expect(api.counters.effects).toBe(1);
  });

  it("KEY-07/KEY-08: isolates HTTP results across users and application namespaces", async () => {
    const store = new MemoryStore();
    // This header is a controlled test identity, not a production authentication recipe.
    const api = await makeHttpApp({ store, scope: (req) => req.get("X-Test-User") ?? "public-test" }, (req, res) => res.status(201).json({ owner: req.get("X-Test-User") }));

    for (const user of ["user-A", "user-B"]) {
      const first = await api.send().set("X-Test-User", user);
      const replay = await api.send().set("X-Test-User", user);

      expect(first.status).toBe(201);
      expect(replay.body.owner).toBe(user);
      expect(replay.headers["idempotency-status"]).toBe("cached");
    }

    const other = await makeHttpApp({ store, namespace: "another-app" });

    expect((await other.send()).headers["idempotency-status"]).toBe("created");
    expect(api.counters.calls).toBe(2);
  });

  it("HTTP-03: does not finish the response before commit acknowledgement", async () => {
    const entered = deferred();
    const gate = deferred();

    class SlowStore extends MemoryStore {
      override async commit(key: string, data: CachedResponse, owner: string): Promise<CommitResult> {
        entered.resolve(); await gate.promise;

        return super.commit(key, data, owner);
      }
    }

    const api = await makeHttpApp({ store: new SlowStore() });
    let finished = false;
    const pending = api.send().then((value) => { finished = true;

      return value; });

    await entered.promise;
    expect(finished).toBe(false);
    gate.resolve();
    expect((await pending).status).toBe(201);
  });

  it("HTTP-08: commit failure retains ownership and never returns the original 201", async () => {
    class FailingStore extends MemoryStore {
      override async commit(): Promise<CommitResult> { throw new Error("redis://secret"); }
    }

    const store = new FailingStore();
    const api = await makeHttpApp({ store });
    const failed = await api.send();

    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ code: "idempotency_result_unknown", outcome: "unknown" });
    expect(failed.text).not.toContain("redis://secret");
    expect((await store.read(physicalKey()))?.kind).toBe("inflight");
    expect((await api.send()).status).toBe(409);
    expect(api.counters.effects).toBe(1);
  });

  it("HTTP-09: a lost commit ACK does not delete an already completed result", async () => {
    class AckLostStore extends MemoryStore {
      override async commit(key: string, data: CachedResponse, owner: string): Promise<CommitResult> {
        await super.commit(key, data, owner);

        throw new Error("ack lost");
      }
    }

    const api = await makeHttpApp({ store: new AckLostStore() });

    expect((await api.send()).status).toBe(503);
    const replay = await api.send();

    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-status"]).toBe("cached");
    expect(api.counters.effects).toBe(1);
  });

  it.each(["resolve", "reject"])("HTTP-10: observes a late commit %s after timeout", async (settlement) => {
    const gate = deferred();
    const done = deferred();

    class LateStore extends MemoryStore {
      override async commit(key: string, data: CachedResponse, owner: string): Promise<CommitResult> {
        await gate.promise;
        try {
          if (settlement === "reject") throw new Error("late rejection");

          return await super.commit(key, data, owner);
        } finally { done.resolve(); }
      }
    }

    const store = new LateStore();
    const api = await makeHttpApp({ store, storeTimeoutMs: 20 });
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("idempotency_result_unknown");
    gate.resolve();
    await done.promise;
    const again = await api.send();

    expect(again.status).toBe(settlement === "resolve" ? 201 : 409);
    expect(api.counters.effects).toBe(1);
  });

  it.each([{ kind: "reservation-lost" }, undefined, { kind: "unexpected" }, new StoreCapacityError()])("HTTP-11: treats failed or malformed commit %j as unknown", async (outcome) => {
    class BadStore extends MemoryStore {
      override async commit(): Promise<CommitResult> {
        if (outcome instanceof Error) throw outcome;

        return outcome as CommitResult;
      }
    }

    const api = await makeHttpApp({ store: new BadStore() });

    expect((await api.send()).body.error.code).toBe("idempotency_result_unknown");
    expect((await api.send()).status).toBe(409);
    expect(api.counters.effects).toBe(1);
  });

  it("sends the canonical first-write-wins result, not the second candidate or its cookie", async () => {
    class CanonicalStore extends MemoryStore {
      override async commit(key: string, data: CachedResponse, owner: string): Promise<CommitResult> {
        await super.commit(key, { ...data, status: 202, body: Buffer.from("canonical"), headers: { "content-type": "text/plain" } }, owner);

        return super.commit(key, data, owner);
      }
    }

    const api = await makeHttpApp({ store: new CanonicalStore() }, (_req, res) => {
      res.setHeader("Set-Cookie", "candidate=wrong");
      res.status(201).end("candidate");
    });
    const result = await api.send();

    expect(result.status).toBe(202);
    expect(result.text).toBe("canonical");
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("HTTP-18: seals body, status and headers while commit is pending", async () => {
    const gate = deferred();
    const entered = deferred();

    class SlowStore extends MemoryStore {
      commits = 0;
      override async commit(key: string, data: CachedResponse, owner: string) {
        this.commits++; entered.resolve(); await gate.promise;

        return super.commit(key, data, owner);
      }
    }

    const store = new SlowStore();
    const api = await makeHttpApp({ store }, (_req, res) => {
      res.status(201).setHeader("Content-Type", "text/plain");
      res.end("first");
      res.status(500).setHeader("Content-Type", "application/json");
      res.end("second");
    });
    const pending = api.send().then((result) => result);

    await entered.promise; gate.resolve();
    const result = await pending;

    expect(result.status).toBe(201);
    expect(result.text).toBe("first");
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(store.commits).toBe(1);
  });

  it("HTTP-19: rechecks the operation budget after synchronous observer work", async () => {
    let now = 0;

    vi.spyOn(performance, "now").mockImplementation(() => now);
    const api = await makeHttpApp({ storeTimeoutMs: 100, onEvent: (event) => {
      if (event.type === "started") now = 101;
    } });
    const result = await api.send();

    expect(result.body.error.code).toBe("idempotency_store_unavailable");
    expect(api.counters.calls).toBe(0);
  });

  it.each(["operation", "retention"])("HTTP-19: refuses a late started result after the %s budget", async (budget) => {
    let now = 0;

    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    class LateBeginStore extends MemoryStore {
      override async begin(key: string, fp: string, ttl: number) {
        const result = await super.begin(key, fp, ttl);

        now = budget === "operation" ? 1001 : 11;

        return result;
      }
    }

    const api = await makeHttpApp({ store: new LateBeginStore(), ttlMs: 10, storeTimeoutMs: 1000 });
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe(budget === "operation" ? "idempotency_store_unavailable" : "idempotency_result_unknown");
    expect(api.counters.calls).toBe(0);
  });
});

describe("v3 limits, headers and unsupported responses", () => {
  it.each([0, 4])("HTTP-15: enforces a Buffer byte limit of %s without truncation", async (maxResponseBytes) => {
    const body = Buffer.from([0, 255, 1, 128]);
    const api = await makeHttpApp({ maxResponseBytes }, (_req, res) => res.end(body));
    const result = await api.send();

    expect(result.status).toBe(maxResponseBytes === 0 ? 503 : 200);
    const entry = await api.options.store.read(physicalKey());

    if (maxResponseBytes === 0) expect(entry?.kind).toBe("inflight");
    else {
      if (entry?.kind !== "completed") throw new Error("Expected completed entry");

      expect(entry.cached.body).toEqual(body);
    }
  });

  it("HTTP-15: accepts the exact UTF-8 response byte limit and rejects an oversized result", async () => {
    const exact = await makeHttpApp({ maxResponseBytes: 6 }, (_req, res) => res.type("text").end("界界"));

    expect((await exact.send()).text).toBe("界界");
    expect((await exact.send()).headers["idempotency-status"]).toBe("cached");
    const over = await makeHttpApp({ maxResponseBytes: 5 }, (_req, res) => res.end("界界"));
    const failed = await over.send();

    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("idempotency_response_too_large");
    expect((await over.send()).status).toBe(409);
    expect(over.counters.effects).toBe(1);
  });

  it("HTTP-16: enforces the filtered header budget before commit", async () => {
    const store = new MemoryStore();
    const commit = vi.spyOn(store, "commit");
    const api = await makeHttpApp({ store, replay: { headerWhitelist: ["x-large"] } }, (_req, res) => {
      res.setHeader("X-Large", "a".repeat(16_384));
      res.end("body");
    });
    const result = await api.send();

    expect(result.body.error.code).toBe("idempotency_response_too_large");
    expect(result.headers["x-large"]).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect((await store.read(physicalKey()))?.kind).toBe("inflight");
  });

  const unsupported: Array<[string, (res: Response) => void]> = [
    ["write", (res) => { res.write("partial"); res.end("tail"); }],
    ["writeHead", (res) => { res.writeHead(201); res.end("body"); }],
    ["flushHeaders", (res) => { res.flushHeaders(); res.end("body"); }],
    ["trailers", (res) => { res.addTrailers({ "x-trailer": "value" }); res.end(); }],
    ["interim response", (res) => { res.writeContinue(); res.end(); }],
    ["sendFile", (res) => { res.sendFile("/file-that-must-not-be-read"); }],
    ["download", (res) => { res.download("/file-that-must-not-be-read"); }],
    ["manual compressed body", (res) => { res.setHeader("Content-Encoding", "gzip"); res.end("compressed"); }],
    ["upgrade status", (res) => { res.status(101).end(); }],
  ];

  it.each(unsupported)("HTTP-17: rejects %s without caching a partial response or releasing ownership", async (_name, action) => {
    const store = new MemoryStore();
    const commit = vi.spyOn(store, "commit");
    const api = await makeHttpApp({ store }, (_req, res) => action(res));
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("idempotency_response_unsupported");
    expect(commit).not.toHaveBeenCalled();
    expect((await store.read(physicalKey()))?.kind).toBe("inflight");
    expect((await api.send()).status).toBe(409);
  });

  it("META-03: never stores secrets, transport or spoofed idempotency headers, even when whitelisted", async () => {
    const store = new MemoryStore();
    const headers = ["set-cookie", "cookie", "authorization", "www-authenticate", "proxy-secret", "connection", "x-hop", "idempotency-status", "idempotency-replayed", "location"];
    const api = await makeHttpApp({ store, replay: { headerWhitelist: headers } }, (_req, res) => {
      res.setHeader("Set-Cookie", "session=secret");
      res.setHeader("Cookie", "secret");
      res.setHeader("Authorization", "secret");
      res.setHeader("WWW-Authenticate", "secret");
      res.setHeader("Proxy-Secret", "secret");
      res.setHeader("Connection", "x-hop");
      res.setHeader("X-Hop", "secret");
      res.setHeader("Idempotency-Status", "spoofed");
      res.setHeader("Idempotency-Replayed", "true");
      res.location("/orders/one").status(201).json({ id: "one" });
    });
    const first = await api.send();

    expect(first.headers["idempotency-status"]).toBe("created");
    expect(first.headers["idempotency-replayed"]).toBe("false");
    const entry = await store.read(physicalKey());

    if (entry?.kind !== "completed") throw new Error("Expected completed entry");

    expect(entry.cached.headers).toEqual({ "content-type": "application/json; charset=utf-8", location: "/orders/one" });
    const second = await api.send();

    expect(second.headers["idempotency-status"]).toBe("cached");
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(second.headers["x-hop"]).toBeUndefined();
  });

  it.each([false, true])("META-04: observer errors are isolated (async=%s)", async (async) => {
    const onEvent = vi.fn(() => {
      if (async) return Promise.reject(new Error("private logger error"));

      throw new Error("private logger error");
    });
    const api = await makeHttpApp({ onEvent });

    expect((await api.send("private-key")).status).toBe(201);
    expect((await api.send("private-key")).headers["idempotency-status"]).toBe("cached");
    expect(api.counters.effects).toBe(1);
    const events = JSON.stringify(onEvent.mock.calls);

    expect(events).not.toContain("private-key");
    expect(events).not.toContain("public-test");
    expect(events).not.toContain("orderId");
    expect(onEvent).toHaveBeenCalledTimes(3);
  });
});

describe("v3 malformed Store results and wait", () => {
  it.each([undefined, null, [], {}, { kind: "started" }, { kind: "unknown" },
    { kind: "started", reservationId: "owner", expiresAt: 0 },
    { kind: "started", reservationId: "owner", expiresAt: Infinity },
    { kind: "replay", entry: { kind: "inflight", reservationId: "owner", expiresAt: 999, fingerprint: "a".repeat(64) } },
  ])("HTTP-07: rejects malformed begin result %j", async (result) => {
    class BadStore extends MemoryStore { override async begin(): Promise<BeginResult> { return result as BeginResult; } }

    const api = await makeHttpApp({ store: new BadStore() });

    expect((await api.send()).body.error.code).toBe("idempotency_store_invalid");
    expect(api.counters.calls).toBe(0);
  });

  function scriptedStore(read: (fp: string, owner: { reservationId: string; expiresAt: number }) => StoreEntry | null | Promise<StoreEntry | null>): Store {
    const owner = { reservationId: "external-owner", expiresAt: Date.now() + 60_000 };
    let fingerprint = "";

    return {
      protocolVersion: 3,
      begin: vi.fn(async (_key: string, fp: string): Promise<BeginResult> => { fingerprint = fp;

        return { kind: "inflight", ...owner }; }),
      read: vi.fn(async () => read(fingerprint, owner)),
      commit: vi.fn(async () => { throw new Error("waiter must never commit"); }),
    };
  }

  it("WAIT-01: replays a completed result belonging to the same reservation", async () => {
    const store = scriptedStore((fingerprint, owner) => ({ kind: "completed", ...owner, fingerprint, cached: {
      status: 202, body: Buffer.from("external"), headers: { "content-type": "text/plain" }, fingerprint, createdAt: Date.now(),
    } }));
    const api = await makeHttpApp({ store, inFlight: { strategy: "wait" } });
    const result = await api.send();

    expect(result.status).toBe(202);
    expect(result.text).toBe("external");
    expect(result.headers["idempotency-status"]).toBe("cached");
    expect(api.counters.calls).toBe(0);
  });

  it.each(["missing", "new-owner", "changed-deadline"])("WAIT-03/WAIT-04: does not claim after %s", async (state) => {
    const store = scriptedStore((fingerprint, owner) => state === "missing" ? null : {
      kind: "inflight", fingerprint, ...owner,
      ...(state === "new-owner" ? { reservationId: "new-owner" } : { expiresAt: owner.expiresAt + 1 }),
    });
    const api = await makeHttpApp({ store, inFlight: { strategy: "wait" } });
    const result = await api.send();

    expect(result.body.error.code).toBe("idempotency_result_unknown");
    expect(store.begin).toHaveBeenCalledTimes(1);
    expect(store.commit).not.toHaveBeenCalled();
    expect(api.counters.calls).toBe(0);
  });

  it("WAIT-02: times out without releasing or claiming", async () => {
    const store = scriptedStore((fingerprint, owner) => ({ kind: "inflight", fingerprint, ...owner }));
    const api = await makeHttpApp({ store, inFlight: { strategy: "wait", pollMs: 3, waitTimeoutMs: 15 } });
    const result = await api.send();

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("idempotency_wait_timeout");
    expect(result.headers["retry-after"]).toBe("1");
    expect(store.begin).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])("WAIT-06: applies the remaining wait budget to pending reads and observes late %s", async (outcome) => {
    const gate = deferred<StoreEntry | null>();
    const store = scriptedStore(() => gate.promise);
    const api = await makeHttpApp({ store, storeTimeoutMs: 1000, inFlight: { strategy: "wait", pollMs: 3, waitTimeoutMs: 15 } });
    const result = await api.send();

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("idempotency_wait_timeout");
    if (outcome === "reject") gate.reject(new Error("late private rejection"));
    else gate.resolve(null);

    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it.each(["failure", "bad-fingerprint", "undefined"])("WAIT-05: rejects read %s without invoking the handler", async (state) => {
    const store = scriptedStore((_fingerprint, owner) => {
      if (state === "failure") throw new Error("private store error");

      if (state === "undefined") return undefined as unknown as null;

      return { kind: "inflight", ...owner, fingerprint: "b".repeat(64) };
    });
    const api = await makeHttpApp({ store, inFlight: { strategy: "wait" } });
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe(state === "failure" ? "idempotency_store_unavailable" : "idempotency_store_invalid");
    expect(api.counters.calls).toBe(0);
    expect(store.begin).toHaveBeenCalledTimes(1);
  });
});
