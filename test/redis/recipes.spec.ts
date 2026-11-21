import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildStorageKey } from "../../src/v3/key.js";
import { runRecipeContract } from "../helpers/recipe-contract.js";
import { redisWorker } from "../helpers/redis-process.js";
import { connectRedis, isolatedRedis, redisUrl, type TestRedis } from "../helpers/redis.js";

let client: TestRedis;

beforeAll(async () => { client = await connectRedis(); });
afterAll(async () => { if (client?.isOpen) await client.close(); });
runRecipeContract("RedisStore", () => isolatedRedis(client));

it("runs the actual authenticated tenant recipe across two independent instances and reauthorizes cached results", async () => {
  const scope = randomUUID();
  const effectKey = `idem:test:${scope}:recipe-effects`;
  const key = buildStorageKey("tenant-recipe-process", JSON.stringify([scope, "recipe-user"]), "key");
  const workers: Array<Awaited<ReturnType<typeof redisWorker>>> = [];

  try {
    for (let i = 0; i < 2; i++) workers.push(await redisWorker({ url: redisUrl(), scope, effectKey, recipe: true }));

    const send = (index: number, token = "fixture-old-token") => request(workers[index].url).post("/orders")
      .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "key").send({ amount: 100, currency: "USD" });
    const first = send(0).then((response) => response);

    await workers[0].waitFor((events) => events.some((event) => event.type === "handler"));
    const second = send(1, "fixture-new-token").then((response) => response);

    await workers[1].waitFor((events) => events.some((event) => event.type === "begin"));
    workers[0].release();
    const [original, replay] = await Promise.all([first, second]);

    expect(original.status).toBe(201); expect(replay.status).toBe(201);
    expect(replay.text).toBe(original.text);
    expect(replay.headers["idempotency-status"]).toBe("cached");
    expect(await client.get(effectKey)).toBe("1");
    workers[1].revoke();
    await workers[1].waitFor((events) => events.some((event) => event.type === "revoked"));
    expect((await send(1, "fixture-new-token")).status).toBe(403);
    expect(workers[1].messages.filter((event) => event.type === "begin")).toHaveLength(1);
  } finally {
    await Promise.all(workers.map((worker) => worker.kill()));
    await client.del([key, effectKey]);
  }
});
