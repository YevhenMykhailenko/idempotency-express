import express from "express";
import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import { createHash } from "node:crypto";

import { idempotencyMiddleware, type Store } from "../src/index.js";

export type Identity = { tenantId: string; userId: string };
export type OrderInput = { amount: number; currency: string };
export type TenantApiOptions = {
  store: Store;
  namespace: string;
  authenticate: (req: Request) => Identity | undefined | Promise<Identity | undefined>;
  authorize: (identity: Identity, req: Request) => boolean | Promise<boolean>;
  rateLimit?: RequestHandler;
  createOrder: (operation: { identity: Identity; input: OrderInput; downstreamKey: string }) => Promise<{ id: string }>;
};

/** Application recipe, not a library auth implementation. Both checks run on EVERY retry. */
export function createTenantApi(options: TenantApiOptions) {
  const app = express();
  const identities = new WeakMap<Request, Identity>();
  const identity = (req: Request): Identity => {
    const value = identities.get(req);
    if (!value) throw new Error("Authenticated identity is required");
    return value;
  };
  const authenticate: RequestHandler = (req, res, next) => {
    void Promise.resolve().then(() => options.authenticate(req)).then((value) => {
      if (!value) { res.status(401).json({ error: "authentication_required" }); return; }
      // Copy stable IDs; never use the bearer token itself or an unverified tenant header as scope.
      if (typeof value.tenantId !== "string" || !value.tenantId || typeof value.userId !== "string" || !value.userId) {
        throw new Error("Invalid authenticated identity");
      }
      identities.set(req, { tenantId: value.tenantId, userId: value.userId });
      next();
    }).catch(next);
  };
  const authorize: RequestHandler = (req, res, next) => {
    void Promise.resolve().then(() => options.authorize(identity(req), req)).then((allowed) => {
      if (!allowed) { res.status(403).json({ error: "forbidden" }); return; }
      next();
    }).catch(next);
  };
  const validate: RequestHandler = (req, res, next) => {
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.status(400).json({ error: "invalid_order" }); return;
    }
    const { amount, currency } = body as Record<string, unknown>;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 ||
        typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      res.status(400).json({ error: "invalid_order" }); return;
    }
    next();
  };
  const scope = (req: Request) => JSON.stringify([identity(req).tenantId, identity(req).userId]);
  app.post("/orders", authenticate, authorize, ...(options.rateLimit ? [options.rateLimit] : []),
    express.json({ limit: "16kb" }), validate,
    idempotencyMiddleware({
      store: options.store, namespace: options.namespace, scope,
      ttlMs: 86_400_000, inFlight: { strategy: "wait", pollMs: 100, waitTimeoutMs: 3000 },
      replay: { headerWhitelist: ["location"] },
    }),
    (req, res, next) => {
      const current = identity(req);
      const { amount, currency } = req.body as OrderInput;
      const downstreamKey = createHash("sha256").update(JSON.stringify([
        options.namespace, current.tenantId, current.userId, "/orders", req.get("Idempotency-Key"),
      ])).digest("hex");
      // Passing a key is NOT enforcement: the application/provider must actually honor it.
      void Promise.resolve().then(() => options.createOrder({ identity: current, input: { amount, currency }, downstreamKey }))
        .then((order) => { res.location(`/orders/${encodeURIComponent(order.id)}`).status(201).json(order); }).catch(next);
    });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = typeof error === "object" && error !== null && "status" in error && error.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 400 ? "invalid_json" : "request_failed" });
  };
  app.use(errorHandler);
  return app;
}
