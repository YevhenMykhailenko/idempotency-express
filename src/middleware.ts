import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { CachedResponse, IdemOptions, Reservation } from "./types.js";
import { captureResponse } from "./utils/capture-response.js";
import { buildFingerprint, FingerprintBodyTooLargeError } from "./utils/fingerprint.js";
import { filterHeaders } from "./utils/headers.js";
import { DisconnectedError, monotonicNow, sleep, withDeadline } from "./v3/deadline.js";
import { StoreCapacityError, StoreDataError } from "./v3/errors.js";
import { HttpFailure, sendFailure, setIdempotencyHeaders } from "./v3/http-error.js";
import { assertClientKey, assertScope, buildStorageKey } from "./v3/key.js";
import { normalizeOptions } from "./v3/options.js";
import { validateBegin, validateCommit, validateEntry } from "./v3/protocol.js";

export function idempotencyMiddleware(options: IdemOptions): RequestHandler {
  const config = normalizeOptions(options);
  const { store, emit } = config;

  async function storeCall<T>(operation: "begin" | "read" | "commit", call: () => Promise<T>, budget = config.storeTimeoutMs, signal?: AbortSignal): Promise<T> {
    const start = monotonicNow();

    try { return await withDeadline(call, budget, signal); } catch (error) {
      if (error instanceof DisconnectedError) throw error;

      const reason = error instanceof StoreDataError ? "store_invalid"
        : operation === "begin" && error instanceof StoreCapacityError ? "capacity_exceeded" : "store_unavailable";

      emit({ type: "store-error", operation, code: `idempotency_${reason}`, durationMs: monotonicNow() - start });

      throw new HttpFailure(reason);
    }
  }

  function replay(res: Response, key: string, cached: CachedResponse): void {
    if (res.destroyed || res.writableEnded) return;

    if (res.headersSent) { res.destroy();

      return; }

    for (const name of ["content-length", "content-encoding", "etag", "location", "content-type"]) res.removeHeader(name);

    for (const [name, value] of Object.entries(filterHeaders(cached.headers, config.whitelist))) res.setHeader(name, value);

    res.statusCode = cached.status;
    setIdempotencyHeaders(res, key, "cached");
    res.end(cached.body);
    emit({ type: "replayed", status: cached.status });
  }

  async function wait(res: Response, key: string, storageKey: string, fingerprint: string, owner: Reservation): Promise<void> {
    const controller = new AbortController();
    const close = (): void => { controller.abort(); };

    res.once("close", close);
    const deadline = monotonicNow() + config.waitTimeoutMs;

    try {
      while (!res.destroyed && !controller.signal.aborted) {
        const remaining = deadline - monotonicNow();

        if (remaining <= 0) throw new HttpFailure("wait_timeout");

        let entry;

        try {
          entry = await storeCall("read", async () => {
            const value = await store.read(storageKey);

            return value === null ? null : validateEntry(value);
          }, Math.min(config.storeTimeoutMs, remaining), controller.signal);
        } catch (error) {
          if (error instanceof DisconnectedError) return;

          if (monotonicNow() >= deadline) throw new HttpFailure("wait_timeout");

          throw error;
        }

        if (!entry || entry.reservationId !== owner.reservationId || entry.expiresAt !== owner.expiresAt) {
          throw new HttpFailure("result_unknown");
        }

        if (entry.fingerprint !== fingerprint) throw new HttpFailure("store_invalid");

        if (entry.kind === "completed") { replay(res, key, entry.cached);

          return; }

        await sleep(Math.min(config.pollMs, Math.max(0, deadline - monotonicNow())), controller.signal);
      }
    } catch (error) {
      if (error instanceof DisconnectedError) return;

      if (error instanceof HttpFailure && error.reason === "wait_timeout") emit({ type: "wait-timeout", code: error.code });

      throw error;
    } finally { res.removeListener("close", close); }
  }

  return async function handler(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!config.methods.has(req.method.toUpperCase())) { next();

      return; }

    let key: string | undefined;
    let captured: ReturnType<typeof captureResponse> | undefined;

    try {
      const extracted = extractKey(req);

      if (extracted === undefined) {
        if (config.requireKey) throw new HttpFailure("key_required");

        emit({ type: "bypassed" });
        next();

        return;
      }

      try { assertClientKey(extracted); } catch { throw new HttpFailure("key_invalid"); }

      key = extracted;
      let scope: string;

      try {
        const value: unknown = typeof config.scope === "function" ? config.scope(req) : config.scope;

        observeAsync(value);
        assertScope(value);
        scope = value;
      } catch { throw new HttpFailure("scope_invalid"); }

      if (req.body === undefined && (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"])) {
        throw new HttpFailure("body_unparsed");
      }

      let fingerprint: string;

      try {
        const custom = config.fingerprint.custom;

        fingerprint = buildFingerprint(req, { ...config.fingerprint, ...(custom ? { custom: (request: Request) => {
          const value = custom(request);

          observeAsync(value);

          return value;
        } } : {}) });
      } catch (error) {
        throw new HttpFailure(error instanceof FingerprintBodyTooLargeError ? "body_too_large" : "fingerprint_failed");
      }

      if (res.destroyed || res.writableEnded) return;

      if (res.headersSent) { res.destroy();

        return; }

      const storageKey = buildStorageKey(config.namespace, scope, key);
      const start = monotonicNow();
      const begin = await storeCall("begin", async () => validateBegin(await store.begin(storageKey, fingerprint, config.ttlMs), fingerprint));

      if (res.destroyed || res.writableEnded) return;

      if (res.headersSent) { res.destroy();

        return; }

      if (begin.kind === "conflict") {
        emit({ type: "conflict" });

        throw new HttpFailure("conflict");
      }

      if (begin.kind === "replay") { replay(res, key, begin.entry.cached);

        return; }

      if (begin.kind === "inflight") {
        emit({ type: "inflight" });
        if (config.strategy === "reject") throw new HttpFailure("inflight");

        await wait(res, key, storageKey, fingerprint, begin);

        return;
      }

      if (monotonicNow() - start >= config.ttlMs) throw new HttpFailure("result_unknown");

      captured = captureResponse(res, {
        key, fingerprint, whitelist: config.whitelist, maxResponseBytes: config.maxResponseBytes,
        commit: async (cached) => {
          try {
            const result = await storeCall("commit", async () => validateCommit(
              await store.commit(storageKey, cached, begin.reservationId), fingerprint, begin,
            ));

            if (result.kind === "reservation-lost") throw new HttpFailure("result_unknown");

            const canonical = result.kind === "already-committed";
            const response = result.kind === "already-committed" ? result.entry.cached : cached;

            emit({ type: "completed", status: response.status });

            return { cached: response, canonical };
          } catch { throw new HttpFailure("result_unknown"); }
        },
        onFailure: (failure) => { emit({ type: "outcome-unknown", code: failure.code, status: failure.status }); },
      });
      emit({ type: "started" });
      const elapsed = monotonicNow() - start;

      if (elapsed >= config.storeTimeoutMs || elapsed >= config.ttlMs) {
        captured.fail(new HttpFailure(elapsed >= config.storeTimeoutMs ? "store_unavailable" : "result_unknown"));

        return;
      }

      if (!res.destroyed && !res.writableEnded) next();
    } catch (error) {
      const failure = error instanceof HttpFailure ? error : new HttpFailure("store_unavailable");

      if (captured) captured.fail(new HttpFailure("result_unknown"));
      else {
        if (failure.unknown) emit({ type: "outcome-unknown", code: failure.code, status: failure.status });

        sendFailure(res, failure, key);
      }
    }
  };

  function extractKey(req: Request): unknown {
    if (config.getKey) {
      try {
        const value: unknown = config.getKey(req);

        observeAsync(value);
        if (value !== undefined && typeof value !== "string") throw new Error("Invalid extractor result");

        return value;
      } catch { throw new HttpFailure("extractor_failed"); }
    }

    let count = 0;

    for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
      if (req.rawHeaders[i].toLowerCase() === config.keyHeader) count++;
    }

    const value = req.headers[config.keyHeader];

    if (count > 1 || (value !== undefined && typeof value !== "string")) throw new HttpFailure("key_invalid");

    return value;
  }
}

function observeAsync(value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    void Promise.resolve(value).catch(() => undefined);
  }
}
