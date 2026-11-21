import type { Response } from "express";

const definitions = {
  key_required: [400, "An idempotency key is required"],
  key_invalid: [400, "The idempotency key is invalid or duplicated"],
  scope_invalid: [500, "The request scope could not be determined"],
  extractor_failed: [500, "The idempotency key could not be extracted"],
  body_unparsed: [400, "Parse the request body before idempotency middleware"],
  body_too_large: [413, "The canonical request body exceeds maxBodyBytes"],
  fingerprint_failed: [500, "The request fingerprint could not be calculated"],
  capacity_exceeded: [503, "Idempotency store capacity exceeded"],
  store_unavailable: [503, "The idempotency store is unavailable"],
  store_invalid: [503, "The idempotency store returned invalid data"],
  conflict: [409, "The idempotency key was used with a different request"],
  inflight: [409, "An operation with this key is still outstanding"],
  wait_timeout: [409, "No result was confirmed before the wait deadline"],
  result_unknown: [503, "The operation result could not be confirmed; reconcile before using a new key"],
  response_too_large: [503, "The operation response exceeds the replay limits"],
  response_unsupported: [503, "The operation used an unsupported response API"],
} as const;

export type FailureCode = keyof typeof definitions;

export class HttpFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly unknown: boolean;
  readonly idempotencyStatus: string;
  readonly retryAfter: boolean;

  constructor(readonly reason: FailureCode) {
    super(definitions[reason][1]);
    this.status = definitions[reason][0];
    this.code = `idempotency_${reason}`;
    this.unknown = ["inflight", "wait_timeout", "result_unknown", "response_too_large", "response_unsupported"].includes(reason);
    this.idempotencyStatus = reason === "conflict" || reason === "inflight" ? reason
      : reason === "wait_timeout" ? "inflight-timeout" : "error";
    this.retryAfter = reason === "inflight" || reason === "wait_timeout";
  }
}

export function setIdempotencyHeaders(res: Response, key: string | undefined, status: string): void {
  if (key !== undefined) res.setHeader("Idempotency-Key", key);

  res.setHeader("Idempotency-Status", status);
  res.setHeader("Idempotency-Replayed", status === "cached" ? "true" : "false");
}

export function sendFailure(res: Response, failure: HttpFailure, key?: string, end?: (body: string) => void): void {
  if (res.destroyed || res.writableEnded) return;

  if (res.headersSent) { res.destroy();

    return; }

  res.statusCode = failure.status;
  for (const name of ["content-length", "content-encoding", "etag", "location", "set-cookie", "authorization"]) {
    res.removeHeader(name);
  }

  setIdempotencyHeaders(res, key, failure.idempotencyStatus);
  if (failure.retryAfter) res.setHeader("Retry-After", "1");
  else res.removeHeader("Retry-After");

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const body = JSON.stringify({ error: {
    code: failure.code, message: failure.message,
    ...(failure.unknown ? { outcome: "unknown" } : {}),
  } });

  if (end) end(body);
  else res.end(body);
}
