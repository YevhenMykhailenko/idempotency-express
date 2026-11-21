import express from "express";
import type { RequestHandler } from "express";
import { idempotencyMiddleware, MemoryStore } from "express-idempotency-middleware";
import type { CachedResponse, IdemOptions, Store } from "express-idempotency-middleware";
// @ts-expect-error Removed in v3, not an accidentally retained declaration.
import type { Captured } from "express-idempotency-middleware";
import { RedisStore } from "express-idempotency-middleware/redis";
import type { RedisClient, RedisStoreOptions } from "express-idempotency-middleware/redis";

export type RemovedCaptured = Captured;

const memory = new MemoryStore();
const port: RedisClient = { eval: async () => ["missing"] };
const redisOptions: RedisStoreOptions = { client: port };
const redis: Store = new RedisStore(redisOptions);
const options: IdemOptions = { store: memory, namespace: "consumer", scope: (req) => req.get("X-Test-Identity") ?? "public-test" };
const handler: RequestHandler = idempotencyMiddleware(options);

express().post("/orders", handler, (_req, res) => { res.status(201).json({ ok: true }); });
idempotencyMiddleware({ store: redis, namespace: "consumer", scope: "public-test", getKey: () => "event" });
declare const cached: CachedResponse;
void memory.commit("key", cached, "owner");
// @ts-expect-error Token is mandatory.
void memory.commit("key", cached);
// @ts-expect-error No legacy escape hatch.
void memory.get("key");
// @ts-expect-error Namespace and scope are mandatory.
idempotencyMiddleware({ store: memory });
// @ts-expect-error Key sources are mutually exclusive.
idempotencyMiddleware({ ...options, keyHeader: "Idempotency-Key", getKey: () => "event" });
// @ts-expect-error Cached bytes are never a string.
const wrongBody: CachedResponse["body"] = "text";

void wrongBody;
