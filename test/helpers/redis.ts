import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "redis";

import { RedisStore, type RedisClient } from "../../src/redis.js";
import { buildStorageKey } from "../../src/v3/key.js";

export function redisUrl(): string {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for the real Redis suite; no mock/skip fallback");

  return process.env.REDIS_URL;
}

export async function connectRedis(url = redisUrl()) {
  const client = createClient({ url, disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 3000 } });

  client.on("error", () => { /* Commands/connect reject explicitly, including injected disconnects. */ });
  await client.connect();

  return client;
}

export type TestRedis = Awaited<ReturnType<typeof connectRedis>>;

export async function redisNow(client: TestRedis): Promise<number> {
  const value = await client.sendCommand(["TIME"]) as string[];

  return Number(value[0]) * 1000 + Math.floor(Number(value[1]) / 1000);
}

export async function advanceRedisTo(client: TestRedis, deadline: number): Promise<void> {
  const limit = performance.now() + 10_000;

  while (true) {
    const remaining = deadline - await redisNow(client);

    if (remaining <= 0) return;

    if (performance.now() >= limit) throw new Error("Redis authoritative clock did not reach the test deadline");

    await sleep(Math.min(remaining, 25));
  }
}

/** Test-only key routing isolates the unchanged shared suite, without changing records or TTL. */
export function isolatedRedis(client: TestRedis) {
  const scope = randomUUID();
  const keys = new Set<string>();
  const actualKey = (key: string) => buildStorageKey("redis-contract", scope, key);
  const port: RedisClient = {
    eval(script, options) {
      const mapped = options.keys.map((key) => { const actual = actualKey(key);

        keys.add(actual);

        return actual; });

      return client.eval(script, { ...options, keys: mapped });
    },
  };

  return {
    store: new RedisStore({ client: port }), actualKey,
    expiryTtlMs: 300,
    advanceTo: (deadline: number) => advanceRedisTo(client, deadline),
    close: async () => { if (keys.size && client.isReady) await client.del([...keys]); },
  };
}
