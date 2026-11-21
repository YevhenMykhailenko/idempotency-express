import { StoreDataError } from "./errors.js";
import { MAX_CACHED_BODY_BYTES, MAX_CACHED_HEADER_BYTES } from "./limits.js";
import { assertFingerprint, assertReservationId, snapshotCachedResponse } from "./store-data.js";
import type { CachedResponse, StoreEntry } from "./types.js";

export const MAX_BASE64_BYTES = Math.ceil(MAX_CACHED_BODY_BYTES / 3) * 4;
export const MAX_REDIS_RESPONSE_BYTES = MAX_BASE64_BYTES + MAX_CACHED_HEADER_BYTES + 512;
export const MAX_REDIS_RECORD_BYTES = MAX_REDIS_RESPONSE_BYTES + 256;

/** Called synchronously before the first backend yield. */
export function encodeRedisResponse(data: CachedResponse): string {
  const cached = snapshotCachedResponse(data);

  return JSON.stringify({ ...cached, body: cached.body.toString("base64") });
}

function decodeResponse(encoded: string): CachedResponse {
  try {
    if (Buffer.byteLength(encoded) > MAX_REDIS_RESPONSE_BYTES) throw new StoreDataError();

    const value: unknown = JSON.parse(encoded);

    if (typeof value !== "object" || value === null || Array.isArray(value) || JSON.stringify(value) !== encoded) {
      throw new StoreDataError();
    }

    const wire = value as Record<string, unknown>;
    const base64 = wire.body;

    if (typeof base64 !== "string" || base64.length > MAX_BASE64_BYTES || /[^A-Za-z0-9+/=]/.test(base64)) {
      throw new StoreDataError();
    }

    const body = Buffer.from(base64, "base64");

    if (body.length > MAX_CACHED_BODY_BYTES || body.toString("base64") !== base64) throw new StoreDataError();

    return snapshotCachedResponse({ ...wire, body });
  } catch { throw new StoreDataError("Invalid Redis cached response"); }
}

/** Wire v1: five LF-delimited metadata fields, then an empty or JSON response suffix. */
export function decodeRedisEntry(raw: unknown): StoreEntry {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_REDIS_RECORD_BYTES) throw new StoreDataError();

  const fields: string[] = [];
  let offset = 0;

  for (let i = 0; i < 5; i++) {
    const end = raw.indexOf("\n", offset);

    if (end < offset || end - offset > 128) throw new StoreDataError();

    fields.push(raw.slice(offset, end));
    offset = end + 1;
  }

  const [version, kind, fingerprint, reservationId, expiry] = fields;
  const expiresAt = Number(expiry);

  if (version !== "1" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || String(expiresAt) !== expiry) {
    throw new StoreDataError();
  }

  assertFingerprint(fingerprint);
  assertReservationId(reservationId);
  const encoded = raw.slice(offset);

  if (kind === "inflight" && encoded === "") return { kind, fingerprint, reservationId, expiresAt };

  if (kind !== "completed") throw new StoreDataError();

  const cached = decodeResponse(encoded);

  if (cached.fingerprint !== fingerprint) throw new StoreDataError();

  return { kind, fingerprint, reservationId, expiresAt, cached };
}
