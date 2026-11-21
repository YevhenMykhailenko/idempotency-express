/** Working node-redis 5.x connection factory; the application owns the client lifecycle. */
import { createClient } from "redis";

import { RedisStore } from "../src/redis.js";

export async function connectRedisStore(url: string) {
  const client = createClient({ url, disableOfflineQueue: true });
  // Install your application's safe connection diagnostics; do not log credentials.
  client.on("error", () => { console.error("Redis connection error"); });
  await client.connect();
  return { store: new RedisStore({ client }), close: () => client.close() };
}
