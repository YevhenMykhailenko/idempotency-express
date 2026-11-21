import express from "express";
import type { ErrorRequestHandler, Request } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { idempotencyMiddleware, type Store } from "../src/index.js";

export type WebhookEvent = { id: string; type: string; data: unknown };
export type WebhookOptions = {
  store: Store;
  namespace: string;
  accountId: string;
  secrets: readonly Buffer[];
  now?: () => number;
  processEvent: (operation: { accountId: string; event: WebhookEvent; downstreamKey: string }) => void | Promise<void>;
};

/** DEMO protocol: HMAC-SHA256(timestamp + "." + rawBody), NOT a provider-compatible SDK. */
export function createWebhookApp(options: WebhookOptions) {
  if (!options.accountId || !options.secrets.length || options.secrets.some((key) => !Buffer.isBuffer(key) || key.length < 32)) {
    throw new TypeError("A stable account ID and >=32-byte webhook secrets are required");
  }
  const secrets = options.secrets.map((key) => Buffer.from(key));
  const now = options.now ?? Date.now;
  const verified = new WeakMap<Request, WebhookEvent>();
  const event = (req: Request): WebhookEvent => {
    const value = verified.get(req);
    if (!value) throw new Error("No verified event");
    return value;
  };
  const app = express();
  app.post("/webhook", express.raw({ type: "application/json", limit: "32kb", inflate: false }), (req, res, next) => {
    const raw: unknown = req.body;
    const timestamp = singleHeader(req, "x-webhook-timestamp");
    const signature = singleHeader(req, "x-webhook-signature");
    const currentTime = now();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) { res.status(500).json({ error: "webhook_clock_invalid" }); return; }
    if (!Buffer.isBuffer(raw) || !timestamp || !/^[0-9]{1,12}$/.test(timestamp) ||
        !signature || !/^v1=[a-f0-9]{64}$/.test(signature) || Math.abs(currentTime / 1000 - Number(timestamp)) > 300) {
      res.status(401).json({ error: "invalid_webhook_signature" }); return;
    }
    const supplied = Buffer.from(signature.slice(3), "hex");
    const valid = secrets.some((key) => timingSafeEqual(
      createHmac("sha256", key).update(timestamp + ".").update(raw).digest(), supplied,
    ));
    if (!valid) { res.status(401).json({ error: "invalid_webhook_signature" }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch {
      res.status(400).json({ error: "invalid_webhook_event" }); return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      res.status(400).json({ error: "invalid_webhook_event" }); return;
    }
    const data = parsed as Record<string, unknown>;
    if (typeof data.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(data.id) ||
        typeof data.type !== "string" || !data.type || !Object.hasOwn(data, "data")) {
      res.status(400).json({ error: "invalid_webhook_event" }); return;
    }
    verified.set(req, { id: data.id, type: data.type, data: data.data });
    req.body = parsed; // Signature verification has already used the exact raw bytes.
    next();
  }, idempotencyMiddleware({
    store: options.store, namespace: options.namespace,
    scope: JSON.stringify(["verified-webhook-account", options.accountId]),
    getKey: (req) => event(req).id,
    ttlMs: 86_400_000,
  }), (req, res, next) => {
    const current = event(req);
    const downstreamKey = createHash("sha256").update(JSON.stringify([options.namespace, options.accountId, current.id])).digest("hex");
    void Promise.resolve().then(() => options.processEvent({ accountId: options.accountId, event: current, downstreamKey }))
      .then(() => { res.status(204).end(); }).catch(next);
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const oversized = typeof error === "object" && error !== null && "status" in error && error.status === 413;
    const encoded = typeof error === "object" && error !== null && "status" in error && error.status === 415;
    res.status(oversized ? 413 : encoded ? 415 : 500).json({ error: oversized ? "webhook_too_large" : encoded ? "webhook_unsupported_encoding" : "webhook_failed" });
  };
  app.use(errorHandler);
  return app;
}

function singleHeader(req: Request, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count === 1 ? req.get(name) : undefined;
}
