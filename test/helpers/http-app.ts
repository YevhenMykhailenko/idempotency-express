import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";

import { testHttpServer } from "./test-http-server.js";
import { idempotencyMiddleware, MemoryStore, type IdemOptions } from "../../src/index.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });

  return { promise, resolve, reject };
}

export function httpOptions(overrides: Partial<IdemOptions> = {}): IdemOptions {
  return { store: new MemoryStore(), namespace: "http-v3-tests", scope: "public-test", ...overrides } as IdemOptions;
}

export function createHttpApp(overrides: Partial<IdemOptions> = {}, handler?: RequestHandler) {
  const options = httpOptions(overrides);
  const app = express();

  app.use(express.json());
  const counters = { calls: 0, effects: 0 };

  app.post("/orders", idempotencyMiddleware(options), (req, res, next) => {
    counters.calls++;
    counters.effects++;
    if (handler) handler(req, res, next);
    else res.status(201).json({ orderId: "one-order" });
  });

  return { app, options, counters };
}

export async function makeHttpApp(overrides: Partial<IdemOptions> = {}, handler?: RequestHandler) {
  const api = createHttpApp(overrides, handler);
  // Share a ready IPv4 listener; Supertest does not own pre-listening server cleanup.
  const http = await testHttpServer(api.app);
  const { server } = http;
  const send = (key = "key") => request(server).post("/orders").set("Idempotency-Key", key).send({ amount: 100 });

  return { ...api, ...http, send };
}
