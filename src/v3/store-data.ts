import { validateHeaderName, validateHeaderValue } from "node:http";

import { StoreDataError, StoreLimitError } from "./errors.js";
import { MAX_CACHED_BODY_BYTES, MAX_CACHED_HEADER_BYTES, STORAGE_KEY_PREFIX } from "./limits.js";
import type { CachedResponse, HeaderMap, StoreEntry } from "./types.js";

const RESPONSE_FIELDS = new Set(["status", "body", "headers", "fingerprint", "createdAt"]);

export function assertStorageKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== STORAGE_KEY_PREFIX.length + 64 ||
      !value.startsWith(STORAGE_KEY_PREFIX) || /[^a-f0-9]/.test(value.slice(STORAGE_KEY_PREFIX.length))) {
    throw new StoreDataError("Invalid v3 storage key");
  }
}

export function assertFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== 64 || /[^a-f0-9]/.test(value)) {
    throw new StoreDataError("Invalid request fingerprint");
  }
}

export function assertReservationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 ||
      /[^\x21-\x7e]/.test(value)) {
    throw new StoreDataError("Invalid reservation ID");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);

  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new StoreDataError("Store data must contain own enumerable data properties");
  }

  return descriptor.value;
}

function snapshotHeaders(input: unknown): HeaderMap {
  if (!isPlainRecord(input)) throw new StoreDataError("Cached headers must be a plain object");

  const headers: HeaderMap = Object.create(null);
  const names = new Set<string>();
  let bytes = 2; // JSON object braces; count the exact encoded budget before copying values.
  let fields = 0;
  const consume = (count: number): void => {
    bytes += count;
    if (bytes > MAX_CACHED_HEADER_BYTES) {
      throw new StoreLimitError("Cached headers exceed the byte limit");
    }
  };

  const consumeString = (value: string): void => {
    const remaining = MAX_CACHED_HEADER_BYTES - bytes;

    if (value.length > remaining || Buffer.byteLength(value) > remaining) {
      throw new StoreLimitError("Cached headers exceed the byte limit");
    }

    consume(Buffer.byteLength(JSON.stringify(value)));
  };

  const checkValue = (name: string, value: unknown): string => {
    if (typeof value !== "string") throw new StoreDataError("Cached header values must be strings");

    consumeString(value);
    try {
      validateHeaderValue(name, value);
    } catch {
      throw new StoreDataError("Invalid cached header value");
    }

    return value;
  };

  for (const name of Reflect.ownKeys(input)) {
    if (typeof name !== "string") throw new StoreDataError("Cached headers cannot contain symbols");

    if (fields++ > 0) consume(1);

    consumeString(name);
    consume(1); // Colon.
    try {
      validateHeaderName(name);
    } catch {
      throw new StoreDataError("Invalid cached header name");
    }

    const normalized = name.toLowerCase();

    if (names.has(normalized)) throw new StoreDataError("Duplicate cached header name");

    names.add(normalized);

    const value = dataProperty(input, name);

    if (typeof value === "string") {
      headers[name] = checkValue(name, value);
    } else if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
      if (value.length > MAX_CACHED_HEADER_BYTES || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new StoreDataError("Cached header arrays must contain only string elements");
      }

      consume(2); // Array brackets.
      const items: string[] = [];

      for (let i = 0; i < value.length; i++) {
        if (i > 0) consume(1);

        items.push(checkValue(name, dataProperty(value, String(i))));
      }

      headers[name] = items;
    } else {
      throw new StoreDataError("Cached header values must be strings or string arrays");
    }
  }

  return headers;
}

/** Validate and detach the response before a backend can yield to caller mutations. */
export function snapshotCachedResponse(input: unknown): CachedResponse {
  if (!isPlainRecord(input)) throw new StoreDataError("Cached response must be a plain object");

  const fields = Reflect.ownKeys(input);

  if (fields.length !== RESPONSE_FIELDS.size || fields.some((field) =>
    typeof field !== "string" || !RESPONSE_FIELDS.has(field))) {
    throw new StoreDataError("Invalid cached response fields");
  }

  const status = dataProperty(input, "status");
  const body = dataProperty(input, "body");
  const fingerprint = dataProperty(input, "fingerprint");
  const createdAt = dataProperty(input, "createdAt");

  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new StoreDataError("Cached status must be an integer from 200 to 599");
  }

  if (!Buffer.isBuffer(body)) throw new StoreDataError("Cached body must be a Buffer");

  if (body.length > MAX_CACHED_BODY_BYTES) throw new StoreLimitError("Cached body exceeds the byte limit");

  if ((status === 204 || status === 205 || status === 304) && body.length !== 0) {
    throw new StoreDataError("Bodyless response status requires an empty Buffer");
  }

  assertFingerprint(fingerprint);
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new StoreDataError("Cached createdAt must be a non-negative safe integer");
  }

  const headers = snapshotHeaders(dataProperty(input, "headers"));

  return { status, body: Buffer.from(body), headers, fingerprint, createdAt };
}

export function cloneEntry<T extends StoreEntry>(entry: T): T {
  if (entry.kind === "inflight") return { ...entry };

  const headers: HeaderMap = Object.create(null);

  for (const [name, value] of Object.entries(entry.cached.headers)) {
    headers[name] = Array.isArray(value) ? [...value] : value;
  }

  return {
    ...entry,
    cached: { ...entry.cached, body: Buffer.from(entry.cached.body), headers },
  };
}
