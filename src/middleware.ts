import type { NextFunction, Request, Response, RequestHandler } from "express";

import type { CachedResponse, IdemOptions } from "./types.js";
import { captureResponse } from "./utils/capture-response.js";
import { buildFingerprint } from "./utils/fingerprint.js";
import { filterHeaders, lowerCaseHeaders } from "./utils/headers.js";

const DEFAULT_METHODS = ["POST"];
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_HEADER = "Idempotency-Key";

export function idempotencyMiddleware(options: IdemOptions): RequestHandler {
  const {
    store,
    ttlMs = DEFAULT_TTL,
    methods = DEFAULT_METHODS,
    keyHeader = DEFAULT_HEADER,
    requireKey = false,
    inFlight = { strategy: "reject" },
    fingerprint,
    replay,
  } = options;

  const wl = (replay?.headerWhitelist ?? []).map((h) => h.toLowerCase());
  const methodSet = new Set(methods.map((m) => m.toUpperCase()));
  const inFlightLocal = new Map<string, string>(); // key -> fp

  return async function handler(req: Request, res: Response, next: NextFunction) {
    try {
      if (!methodSet.has((req.method || "").toUpperCase())) return next();

      const lower = keyHeader.toLowerCase();
      const key =
        (req.get(keyHeader) ??
          req.get(lower) ??
          (req.headers[lower] as string | undefined) ??
          (req.headers[keyHeader] as string | undefined))?.toString();

      if (!key) {
        if (requireKey) {
          res.setHeader("Idempotency-Status", "missing-key");
          return res.status(400).json({ error: "Idempotency key is required" });
        }
        return next();
      }

      const fp = buildFingerprint(req, fingerprint);

      const local = inFlightLocal.get(key);
      if (local) {
        res.setHeader("Idempotency-Key", key);
        if (local !== fp) {
          res.setHeader("Idempotency-Status", "conflict");
          res.setHeader("Idempotency-Replayed", "false");
          return res.status(409).json({ error: "Idempotency key conflict" });
        }
        if (inFlight.strategy === "reject") {
          res.setHeader("Idempotency-Status", "inflight");
          res.setHeader("Idempotency-Replayed", "false");
          res.setHeader("Retry-After", "1");
          return res.status(409).json({ error: "Request in-flight, retry later" });
        } else {
          const pollMs = inFlight.pollMs ?? 100;
          const timeout = inFlight.waitTimeoutMs ?? 5000;
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const cached = await store.get(key);
            if (cached) {
              if (cached.fingerprint !== fp) {
                res.setHeader("Idempotency-Status", "conflict");
                res.setHeader("Idempotency-Replayed", "false");
                return res.status(409).json({ error: "Idempotency key conflict" });
              }
              res.setHeader("Idempotency-Status", "cached");
              res.setHeader("Idempotency-Replayed", "true");
              res.setHeader("Idempotency-Key", key);
              sendCached(res, cached, wl);
              return;
            }
            await sleep(pollMs);
          }
          res.setHeader("Idempotency-Status", "inflight-timeout");
          res.setHeader("Retry-After", "1");
          return res.status(409).json({ error: "In-flight request timeout, retry later" });
        }
      }

      inFlightLocal.set(key, fp);

      const existing = await store.get(key);
      if (existing) {
        inFlightLocal.delete(key);
        res.setHeader("Idempotency-Key", key);
        if (existing.fingerprint === fp) {
          res.setHeader("Idempotency-Status", "cached");
          res.setHeader("Idempotency-Replayed", "true");
          sendCached(res, existing, wl);
          return;
        } else {
          res.setHeader("Idempotency-Status", "conflict");
          res.setHeader("Idempotency-Replayed", "false");
          return res.status(409).json({ error: "Idempotency key conflict" });
        }
      }

      const begin = await store.begin(key, fp, ttlMs);
      res.setHeader("Idempotency-Key", key);

      if (begin.kind === "replay") {
        inFlightLocal.delete(key);
        if (begin.cached.fingerprint !== fp) {
          res.setHeader("Idempotency-Status", "conflict");
          res.setHeader("Idempotency-Replayed", "false");
          return res.status(409).json({ error: "Idempotency key conflict" });
        }
        res.setHeader("Idempotency-Status", "cached");
        res.setHeader("Idempotency-Replayed", "true");
        sendCached(res, begin.cached, wl);
        return;
      }

      if (begin.kind === "conflict") {
        inFlightLocal.delete(key);
        res.setHeader("Idempotency-Status", "conflict");
        res.setHeader("Idempotency-Replayed", "false");
        return res.status(409).json({ error: "Idempotency key conflict" });
      }

      if (begin.kind === "inflight") {
        inFlightLocal.delete(key);
        if (inFlight.strategy === "reject") {
          res.setHeader("Idempotency-Status", "inflight");
          res.setHeader("Idempotency-Replayed", "false");
          res.setHeader("Retry-After", "1");
          return res.status(409).json({ error: "Request in-flight, retry later" });
        } else {
          const pollMs = inFlight.pollMs ?? 100;
          const timeout = inFlight.waitTimeoutMs ?? 5000;
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const cached = await store.get(key);
            if (cached) {
              if (cached.fingerprint !== fp) {
                res.setHeader("Idempotency-Status", "conflict");
                res.setHeader("Idempotency-Replayed", "false");
                return res.status(409).json({ error: "Idempotency key conflict" });
              }
              res.setHeader("Idempotency-Status", "cached");
              res.setHeader("Idempotency-Replayed", "true");
              sendCached(res, cached, wl);
              return;
            }
            await sleep(pollMs);
          }
          res.setHeader("Idempotency-Status", "inflight-timeout");
          res.setHeader("Retry-After", "1");
          return res.status(409).json({ error: "In-flight request timeout, retry later" });
        }
      }

      const cap = captureResponse(res);

      cap.setOnSend(async (status: number, body: string | Buffer) => {
        if (status >= 200 && status < 500) {
          const headerMap = lowerCaseHeaders(
            res.getHeaders() as Record<string, string | string[]>
          );
          const cached: CachedResponse = {
            status,
            body,
            headers: headerMap,
            fingerprint: fp,
            createdAt: Date.now(),
          };
          try {
            await store.commit(key, cached);
          } catch {
            /* ignore */
          }
        }
      });

      res.once("finish", async () => {
        inFlightLocal.delete(key);

        const body = cap.getBody();
        const status = res.statusCode || 200;

        if (status >= 500) {
          try {
            await store.abort?.(key, fp);
          } catch {
            /* ignore */
          }
          return;
        }

        if (body && status >= 200 && status < 500) {
          const headerMap = lowerCaseHeaders(
            res.getHeaders() as Record<string, string | string[]>
          );
          const cached: CachedResponse = {
            status,
            body,
            headers: headerMap,
            fingerprint: fp,
            createdAt: Date.now(),
          };
          try {
            await store.commit(key, cached);
          } catch {
            /* ignore */
          }
        }
      });

      res.setHeader("Idempotency-Status", "created");
      res.setHeader("Idempotency-Replayed", "false");
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function sendCached(res: Response, cached: CachedResponse, whitelist: string[]) {
  const headers = filterHeaders(cached.headers, whitelist);
  for (const [k, v] of Object.entries(headers)) {
    if (k === "content-length") continue; // нехай Node перерахує
    res.setHeader(k, v as string | string[]);
  }
  res.status(cached.status);
  return res.send(cached.body as string | Buffer);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
