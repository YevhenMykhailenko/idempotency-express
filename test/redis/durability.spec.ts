import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { RedisStore } from "../../src/redis.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { disposableRedis } from "../helpers/disposable-redis.js";
import { makeHttpApp } from "../helpers/http-app.js";
import { connectRedis } from "../helpers/redis.js";

describe.skipIf(process.env.REDIS_RESTART_TEST !== "1")("Redis persistence boundary (owned Docker instance only)", () => {
  it("REDIS-07: acknowledged data loss without persistence permits another effect; no exactly-once claim", async () => {
    const server = await disposableRedis();
    let client: Awaited<ReturnType<typeof connectRedis>> | undefined;

    try {
      client = await connectRedis(server.url);
      const store = new RedisStore({ client: { eval: (script, options) => client!.eval(script, options) } });
      const scope = randomUUID();
      const key = buildStorageKey("http-v3-tests", scope, "key");
      const api = await makeHttpApp({ scope, store });

      expect((await api.send()).headers["idempotency-status"]).toBe("created");
      expect((await store.read(key))?.kind).toBe("completed");
      expect(api.counters.effects).toBe(1);
      await client.close();
      await server.restart();
      client = await connectRedis(server.url);
      expect(await store.read(key)).toBeNull();
      expect((await api.send()).headers["idempotency-status"]).toBe("created");
      expect(api.counters.effects).toBe(2);
    } finally {
      if (client?.isOpen) await client.close();

      await server.close();
    }
  }, 30_000);
});
