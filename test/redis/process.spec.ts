import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RedisStore } from "../../src/redis.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { redisWorker } from "../helpers/redis-process.js";
import { connectRedis, redisNow, redisUrl, type TestRedis } from "../helpers/redis.js";

let client: TestRedis;
const cleanup: Array<() => Promise<unknown>> = [];

beforeAll(async () => { client = await connectRedis(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(async () => { if (client?.isOpen) await client.close(); });

async function workers(mode = "normal") {
  const scope = randomUUID();
  const effectKey = `idem:test:${scope}:effects`;
  const key = buildStorageKey("redis-process", scope, "key");

  cleanup.push(() => client.del([key, effectKey]));
  const options = { url: redisUrl(), scope, effectKey, reject: mode !== "normal" };
  const pair = await Promise.all([redisWorker({ ...options, mode, clockSkew: -86_400_000 }), redisWorker({ ...options, clockSkew: 86_400_000 })].map(async (pending) => {
    const worker = await pending;

    cleanup.push(worker.kill);

    return worker;
  }));

  return { pair, key, effectKey };
}

const send = (url: string) => request(url).post("/orders").set("Idempotency-Key", "key").send({ amount: 100 });

describe("Redis cross-process coordination and hard crash boundaries", () => {
  it("REDIS-02/REDIS-03/HTTP-01: two skewed workers coordinate 100 requests into one handler, effect and commit", async () => {
    const { pair, key, effectKey } = await workers();
    const before = await redisNow(client);
    const pending = Array.from({ length: 100 }, (_, i) => send(pair[i % 2].url).then((result) => result));

    // Both workers remain blocked before the external effect until every claim has been observed.
    await Promise.all(pair.map((worker) => worker.waitFor((events) => events.filter((event) => event.type === "begin").length === 50)));
    const reservation = await new RedisStore({ client }).read(key);
    const after = await redisNow(client);

    expect(reservation?.kind).toBe("inflight");
    expect(reservation?.expiresAt).toBeGreaterThanOrEqual(before + 10_000);
    expect(reservation?.expiresAt).toBeLessThanOrEqual(after + 10_000);
    for (const worker of pair) worker.release();

    const results = await Promise.all(pending);

    expect(results.every((result) => result.status === 201 && result.text === results[0].text)).toBe(true);
    expect(results.filter((result) => result.headers["idempotency-status"] === "created")).toHaveLength(1);
    expect(results.filter((result) => result.headers["idempotency-status"] === "cached")).toHaveLength(99);
    const owner = pair.find((worker) => worker.messages.some((event) => event.type === "handler"));

    expect(owner).toBeDefined();
    await owner!.waitFor((events) => events.some((event) => event.type === "commit"));
    const events = pair.flatMap((worker) => worker.messages);

    expect(events.filter((event) => event.type === "handler")).toHaveLength(1);
    expect(events.filter((event) => event.type === "commit")).toHaveLength(1);
    expect(await client.get(effectKey)).toBe("1");
    const completed = await new RedisStore({ client }).read(key);

    expect(completed?.kind).toBe("completed");
    expect(completed?.reservationId).toBe(reservation?.reservationId);
    expect(completed?.expiresAt).toBe(reservation?.expiresAt);
  });

  it.each(["before-effect", "after-effect"])("HTTP-14: SIGKILL %s leaves an indistinguishable inflight reservation, without retry execution", async (mode) => {
    const { pair: [owner, probe], key, effectKey } = await workers(mode);
    const pending = send(owner.url).then(() => undefined, () => undefined);

    await owner.waitFor((events) => events.some((event) => event.type === (mode === "before-effect" ? "handler" : "effect")));
    const store = new RedisStore({ client });
    const before = await store.read(key);

    expect(before?.kind).toBe("inflight");
    await owner.kill("SIGKILL");
    await pending;
    const retry = await send(probe.url);

    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({ code: "idempotency_inflight", outcome: "unknown" });
    expect(await store.read(key)).toEqual(before);
    expect(await client.get(effectKey)).toBe(mode === "before-effect" ? null : "1");
    expect(probe.messages.filter((event) => event.type === "handler")).toHaveLength(0);
    expect(owner.messages.filter((event) => event.type === "commit")).toHaveLength(0);
  });

  it("HTTP-12: SIGKILL after Redis commit but before its HTTP flush leaves a replayable completed result", async () => {
    const { pair: [owner, probe], key, effectKey } = await workers("after-commit");
    const pending = send(owner.url).then(() => undefined, () => undefined);

    await owner.waitFor((events) => events.some((event) => event.type === "handler"));
    owner.release();
    await owner.waitFor((events) => events.some((event) => event.type === "commit"));
    const completed = await new RedisStore({ client }).read(key);

    expect(completed?.kind).toBe("completed");
    await owner.kill("SIGKILL"); await pending;
    const replay = await send(probe.url);

    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-status"]).toBe("cached");
    expect(await client.get(effectKey)).toBe("1");
    expect(probe.messages.filter((event) => event.type === "handler")).toHaveLength(0);
    expect(await new RedisStore({ client }).read(key)).toEqual(completed);
  });
});
