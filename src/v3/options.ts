import { validateHeaderName } from "node:http";

import { assertNamespace, assertScope } from "./key.js";
import { MAX_CACHED_BODY_BYTES } from "./limits.js";
import type { IdemOptions, IdempotencyEvent } from "./types.js";

function record(value: unknown, name: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function integer(value: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${name}`);
}

export function normalizeOptions(options: IdemOptions) {
  record(options, "options");
  const { store, namespace, scope, getKey, onEvent } = options;

  if (!store || store.protocolVersion !== 3 || [store.begin, store.read, store.commit].some((fn) => typeof fn !== "function")) {
    throw new TypeError("A protocolVersion 3 store with begin, read and commit is required");
  }

  assertNamespace(namespace);
  if (typeof scope !== "function") assertScope(scope);

  if (getKey !== undefined && typeof getKey !== "function") throw new TypeError("getKey must be a function");

  if (getKey !== undefined && options.keyHeader !== undefined) throw new TypeError("Use getKey or keyHeader, not both");

  if (onEvent !== undefined && typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const keyHeader = options.keyHeader === undefined ? "Idempotency-Key" : options.keyHeader;

  if (typeof keyHeader !== "string") throw new TypeError("keyHeader must be a string");

  validateHeaderName(keyHeader);
  const requireKey = options.requireKey === undefined ? true : options.requireKey;

  if (typeof requireKey !== "boolean") throw new TypeError("requireKey must be a boolean");

  const ttlMs = options.ttlMs === undefined ? 86_400_000 : options.ttlMs;
  const storeTimeoutMs = options.storeTimeoutMs === undefined ? 2000 : options.storeTimeoutMs;
  const maxResponseBytes = options.maxResponseBytes === undefined ? 262_144 : options.maxResponseBytes;

  integer(ttlMs, "ttlMs", 1);
  integer(storeTimeoutMs, "storeTimeoutMs", 1, 2_147_483_647);
  integer(maxResponseBytes, "maxResponseBytes", 0, MAX_CACHED_BODY_BYTES);
  const methods = options.methods === undefined ? ["POST"] : options.methods;

  if (!Array.isArray(methods) || methods.length === 0) throw new TypeError("methods must be a nonempty array");

  for (const method of methods) {
    if (typeof method !== "string") throw new TypeError("Invalid HTTP method");

    validateHeaderName(method);
  }

  const inFlight = options.inFlight === undefined ? { strategy: "reject" as const } : options.inFlight;

  record(inFlight, "inFlight");
  if (inFlight.strategy !== "reject" && inFlight.strategy !== "wait") throw new TypeError("Invalid inFlight strategy");

  const waitTimeoutMs = inFlight.waitTimeoutMs === undefined ? 5000 : inFlight.waitTimeoutMs;
  const pollMs = inFlight.pollMs === undefined ? 100 : inFlight.pollMs;

  integer(waitTimeoutMs, "waitTimeoutMs", 1, 2_147_483_647);
  integer(pollMs, "pollMs", 1, waitTimeoutMs);
  const fingerprint = options.fingerprint === undefined ? {} : options.fingerprint;

  record(fingerprint, "fingerprint");
  if (fingerprint.includeQuery !== undefined && typeof fingerprint.includeQuery !== "boolean") throw new TypeError("includeQuery must be boolean");

  if (fingerprint.custom !== undefined && typeof fingerprint.custom !== "function") throw new TypeError("fingerprint.custom must be a function");

  integer(fingerprint.maxBodyBytes === undefined ? 65_536 : fingerprint.maxBodyBytes, "maxBodyBytes", 0);
  const replay = options.replay === undefined ? {} : options.replay;

  record(replay, "replay");
  const whitelist = replay.headerWhitelist === undefined ? [] : replay.headerWhitelist;

  if (!Array.isArray(whitelist)) throw new TypeError("headerWhitelist must be an array");

  for (const header of whitelist) {
    if (typeof header !== "string") throw new TypeError("Invalid replay header name");

    validateHeaderName(header);
  }

  const emit = (event: IdempotencyEvent): void => {
    try { void Promise.resolve(onEvent?.({ ...event })).catch(() => undefined); } catch { /* Observer failures are isolated. */ }
  };

  return {
    store, namespace, scope, getKey, requireKey, ttlMs, storeTimeoutMs, maxResponseBytes,
    keyHeader: keyHeader.toLowerCase(), methods: new Set(methods.map((method) => method.toUpperCase())),
    strategy: inFlight.strategy, waitTimeoutMs, pollMs, fingerprint: { ...fingerprint },
    whitelist: [...new Set(whitelist.map((header) => header.toLowerCase()))], emit,
  };
}
