import type { Response } from "express";

import type { CachedResponse, HeaderMap } from "../types.js";
import { faultHeaders, filterHeaders, lowerCaseHeaders } from "./headers.js";
import { StoreLimitError } from "../v3/errors.js";
import { HttpFailure, sendFailure, setIdempotencyHeaders } from "../v3/http-error.js";
import { snapshotCachedResponse } from "../v3/store-data.js";

type CaptureOptions = {
  key: string;
  fingerprint: string;
  whitelist: string[];
  maxResponseBytes: number;
  commit: (data: CachedResponse) => Promise<{ cached: CachedResponse; canonical: boolean }>;
  onFailure: (failure: HttpFailure) => void;
};

/** Seal one buffered response while commit is pending; no rollback or release is possible. */
export function captureResponse(res: Response, options: CaptureOptions): { fail: (failure: HttpFailure) => void } {
  type Method = (...args: unknown[]) => unknown;
  const mutable = res as unknown as Record<string, unknown>;
  const originals = new Map<string, Method>();
  const original = (name: string): Method => {
    const saved = originals.get(name);

    if (saved) return saved;

    const method = mutable[name];

    if (typeof method !== "function") throw new Error("Missing response method");

    const bound = method.bind(res) as Method;

    originals.set(name, bound);

    return bound;
  };

  const end = original("end");
  const setHeader = original("setHeader");
  const removeHeader = original("removeHeader");
  const baseline = faultHeaders(res.getHeaders());
  let phase: "claimed" | "committing" | "flushing" | "finished" | "fault" = "claimed";
  let inTransport = false;
  let failed = false;

  const transport = (call: () => void): void => {
    inTransport = true;
    try { call(); } finally { inTransport = false; }
  };

  const replaceHeaders = (headers: HeaderMap): void => {
    for (const name of res.getHeaderNames()) removeHeader(name);

    for (const [name, value] of Object.entries(headers)) setHeader(name, value);
  };

  const fail = (failure: HttpFailure): void => {
    if (failed || phase === "flushing" || phase === "finished") return;

    failed = true;
    phase = "fault";
    options.onFailure(failure);
    if (res.destroyed || res.writableEnded) return;

    if (res.headersSent) { res.destroy();

      return; }

    try {
      transport(() => {
        replaceHeaders(baseline);
        sendFailure(res, failure, options.key, (body) => { end(body); });
      });
    } catch { res.destroy(); }
  };

  for (const name of ["setHeader", "removeHeader", "appendHeader", "setHeaders"]) {
    if (typeof mutable[name] !== "function") continue;

    const method = original(name);

    mutable[name] = (...args: unknown[]) => {
      if (phase === "claimed" || inTransport) return method(...args);

      return name === "removeHeader" ? undefined : res;
    };
  }

  for (const name of ["write", "writeHead", "flushHeaders", "addTrailers", "writeContinue", "writeProcessing", "writeEarlyHints", "sendFile", "sendfile", "download", "flush"]) {
    if (typeof mutable[name] !== "function") continue;

    const method = original(name);

    mutable[name] = (...args: unknown[]) => {
      if (inTransport) return method(...args);

      fail(new HttpFailure("response_unsupported"));

      return name === "write" ? false : res;
    };
  }

  res.once("finish", () => { phase = "finished"; });

  mutable.end = (...args: unknown[]): Response => {
    if (phase !== "claimed") return res;

    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;

    if (callback) res.once("finish", callback);

    try {
      if (res.headersSent) throw new HttpFailure("response_unsupported");

      if (res.hasHeader("content-encoding")) throw new HttpFailure("response_unsupported");

      const status = res.statusCode;
      const body = endBody(args, options.maxResponseBytes, status === 204 || status === 205 || status === 304);
      const cached = snapshotCachedResponse({
        status, body,
        headers: filterHeaders(res.getHeaders(), options.whitelist),
        fingerprint: options.fingerprint, createdAt: Date.now(),
      });
      const headers = lowerCaseHeaders(res.getHeaders());

      phase = "committing";
      void options.commit(cached).then((result) => {
        if (failed || phase !== "committing") return;

        phase = "flushing";
        if (res.destroyed || res.writableEnded) { phase = "finished";

          return; }

        if (res.headersSent) { res.destroy();

          return; }

        transport(() => {
          replaceHeaders(result.canonical
            ? { ...baseline, ...filterHeaders(result.cached.headers, options.whitelist) } : headers);
          res.statusCode = result.cached.status;
          setIdempotencyHeaders(res, options.key, "created");
          end(result.cached.body);
        });
      }).catch((error: unknown) => {
        // A transport failure after an acknowledged commit must not invalidate that record.
        if (phase === "flushing" || phase === "finished") { res.destroy();

          return; }

        fail(error instanceof HttpFailure ? error : new HttpFailure("result_unknown"));
      });
    } catch (error) {
      fail(error instanceof HttpFailure ? error
        : new HttpFailure(error instanceof StoreLimitError ? "response_too_large" : "response_unsupported"));
    }

    return res;
  };

  return { fail };
}

function endBody(args: unknown[], maxBytes: number, bodyless: boolean): Buffer {
  const [chunk, encoding, callback] = args;

  if (args.length > 3 || (encoding !== undefined && typeof encoding !== "string" && typeof encoding !== "function") ||
      (callback !== undefined && typeof callback !== "function")) throw new HttpFailure("response_unsupported");

  if (chunk === undefined || chunk === null || typeof chunk === "function") return Buffer.alloc(0);

  if (typeof chunk === "string") {
    const charset = typeof encoding === "string" ? encoding : "utf8";

    if (!Buffer.isEncoding(charset)) throw new HttpFailure("response_unsupported");

    if (bodyless) return Buffer.alloc(0);

    if (Buffer.byteLength(chunk, charset) > maxBytes) throw new HttpFailure("response_too_large");

    return Buffer.from(chunk, charset);
  }

  if (chunk instanceof Uint8Array) {
    if (bodyless) return Buffer.alloc(0);

    if (chunk.byteLength > maxBytes) throw new HttpFailure("response_too_large");

    return Buffer.from(chunk);
  }

  throw new HttpFailure("response_unsupported");
}
