import type { Store } from "express-idempotency-middleware";
import { RedisStore } from "express-idempotency-middleware/redis";
import type { RedisClient } from "express-idempotency-middleware/redis";
import { createClient } from "redis";

const client = createClient();
const port: RedisClient = client;
const store: Store = new RedisStore({ client: port });

void store;
