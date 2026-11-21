import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RedisStore } from "../../src/redis.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { deferred, makeHttpApp } from "../helpers/http-app.js";
import { redisAckProxy } from "../helpers/redis-proxy.js";
import { advanceRedisTo, connectRedis, redisUrl, type TestRedis } from "../helpers/redis.js";
import { response } from "../helpers/store-contract.js";

let client: TestRedis;
const cleanup: Array<() => Promise<unknown>> = [];

beforeAll(async () => { client = await connectRedis(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(async () => { if (client?.isOpen) await client.close(); });

function identity() {
  const scope = randomUUID();
  const key = buildStorageKey("http-v3-tests", scope, "key");

  cleanup.push(() => client.del(key));

  return { scope, key };
}

describe("real Redis HTTP coordination and failures", () => {
  it("META-03: serializes only safe HTTP headers at rest, even with a hostile whitelist", async () => {
    const { scope, key } = identity();
    const store = new RedisStore({ client });
    const api = await makeHttpApp({ scope, store, replay: { headerWhitelist: ["set-cookie", "authorization", "x-hop", "location"] } }, (_req, res) => {
      res.setHeader("Set-Cookie", "never-store-cookie=secret");
      res.setHeader("Authorization", "never-store-authorization");
      res.setHeader("Connection", "x-hop");
      res.setHeader("X-Hop", "never-store-hop");
      res.location("/orders/one").status(201).json({ id: "one" });
    });

    expect((await api.send()).status).toBe(201);
    const raw = await client.get(key);

    expect(raw).not.toContain("never-store-");
    const completed = await store.read(key);

    if (completed?.kind !== "completed") throw new Error("Expected completed result");

    expect(completed.cached.headers).toEqual({ "content-type": "application/json; charset=utf-8", location: "/orders/one" });
    const replay = await api.send();

    expect(replay.headers["set-cookie"]).toBeUndefined();
    expect(replay.headers["authorization"]).toBeUndefined();
    expect(replay.headers["x-hop"]).toBeUndefined();
    expect(api.counters.effects).toBe(1);
  });

  it("REDIS-05: a corrupt live record becomes a protocol failure, never a new HTTP effect", async () => {
    const { scope, key } = identity();

    await client.set(key, "foreign record", { PX: 10_000 });
    const api = await makeHttpApp({ scope, store: new RedisStore({ client }) });
    const result = await api.send();

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("idempotency_store_invalid");
    expect(api.counters.effects).toBe(0);
    expect(await client.get(key)).toBe("foreign record");
  });

  it("HTTP-09/REDIS-06: a real lost commit reply returns unknown and another connection replays the completed result", async () => {
    const { scope, key } = identity();
    const proxy = await redisAckProxy(redisUrl());

    cleanup.push(proxy.close);
    const throughProxy = await connectRedis(proxy.url);

    cleanup.push(async () => { if (throughProxy.isOpen) throughProxy.destroy(); });
    let commitCalls = 0;
    const store = new RedisStore({ client: {
      eval(script, options) {
        if (options.arguments[0] === "commit") { commitCalls++; proxy.arm(); }

        return throughProxy.eval(script, options);
      },
    } });
    const api = await makeHttpApp({ store, scope });
    const result = await api.send();

    await proxy.dropped;
    expect(result.status).toBe(503);
    expect(result.body.error).toMatchObject({ code: "idempotency_result_unknown", outcome: "unknown" });
    const independent = new RedisStore({ client });
    const completed = await independent.read(key);

    expect(completed?.kind).toBe("completed");
    const retry = await makeHttpApp({ store: independent, scope });
    const replay = await retry.send();

    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-status"]).toBe("cached");
    expect(api.counters.effects).toBe(1);
    expect(retry.counters.effects).toBe(0);
    expect(commitCalls).toBe(1);
    expect(await independent.read(key)).toEqual(completed);
    expect(await client.sendCommand(["PEXPIRETIME", key])).toBe(completed?.expiresAt);
  });

  it("WAIT-04: a waiter cannot replay a replacement reservation with the same fingerprint", async () => {
    const { scope, key } = identity();
    const backing = new RedisStore({ client });
    const readEntered = deferred();
    const readGate = deferred();
    let firstRead = true;
    const reader = new RedisStore({ client: {
      async eval(script, options) {
        if (options.arguments[0] === "read" && firstRead) {
          firstRead = false; readEntered.resolve(); await readGate.promise;
        }

        return client.eval(script, options);
      },
    } });
    const ownerApp = await makeHttpApp({ scope, store: backing, ttlMs: 500 }, (_req, res) => { res.destroy(); });

    await ownerApp.send().catch(() => undefined);
    const owner = await backing.read(key);

    if (!owner) throw new Error("Expected reservation");

    const api = await makeHttpApp({ scope, store: reader, inFlight: { strategy: "wait", waitTimeoutMs: 5000, pollMs: 5 } });
    const pending = api.send().then((result) => result);

    await readEntered.promise;
    // Expire naturally; no delete/expiry mutation is used to invent a replacement.
    await advanceRedisTo(client, owner.expiresAt);
    const replacement = await backing.begin(key, owner.fingerprint, 10_000);

    if (replacement.kind !== "started") throw new Error("Expected replacement");

    await backing.commit(key, response({ fingerprint: owner.fingerprint, body: Buffer.from("new attempt") }), replacement.reservationId);
    const canonical = await backing.read(key);

    readGate.resolve();
    const result = await pending;

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("idempotency_result_unknown");
    expect(api.counters.calls).toBe(0);
    expect(await backing.read(key)).toEqual(canonical);
  });

  it("HTTP-08: a real Redis command failure after an effect does not release its reservation", async () => {
    const { scope, key } = identity();
    const store = new RedisStore({ client: {
      eval(script, options) {
        if (options.arguments[0] === "commit") return client.sendCommand(["THIS_COMMAND_DOES_NOT_EXIST"]);

        return client.eval(script, options);
      },
    } });
    const api = await makeHttpApp({ scope, store });
    const failed = await api.send();

    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("idempotency_result_unknown");
    expect((await new RedisStore({ client }).read(key))?.kind).toBe("inflight");
    expect((await api.send()).status).toBe(409);
    expect(api.counters.effects).toBe(1);
  });
});
