import { StoreDataError } from "./errors.js";
import { assertFingerprint, assertReservationId, snapshotCachedResponse } from "./store-data.js";
import type { BeginResult, CommitResult, Reservation, StoreEntry } from "./types.js";

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StoreDataError();

  const proto: unknown = Object.getPrototypeOf(value);

  if (proto !== Object.prototype && proto !== null) throw new StoreDataError();

  const property = Object.getOwnPropertyDescriptor(value, name);

  if (!property?.enumerable || !("value" in property)) throw new StoreDataError();

  return property.value;
}

function reservation(value: unknown): Reservation {
  const reservationId = field(value, "reservationId");
  const expiresAt = field(value, "expiresAt");

  assertReservationId(reservationId);
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new StoreDataError();

  return { reservationId, expiresAt };
}

export function validateEntry(value: unknown): StoreEntry {
  const kind = field(value, "kind");
  const owner = reservation(value);
  const fingerprint = field(value, "fingerprint");

  assertFingerprint(fingerprint);
  if (kind === "inflight") return { kind, ...owner, fingerprint };

  if (kind !== "completed") throw new StoreDataError();

  const cached = snapshotCachedResponse(field(value, "cached"));

  if (cached.fingerprint !== fingerprint) throw new StoreDataError();

  return { kind, ...owner, fingerprint, cached };
}

export function validateBegin(value: unknown, fingerprint: string): BeginResult {
  const kind = field(value, "kind");

  if (kind === "conflict") return { kind };

  if (kind === "started" || kind === "inflight") return { kind, ...reservation(value) };

  if (kind !== "replay") throw new StoreDataError();

  const entry = validateEntry(field(value, "entry"));

  if (entry.kind !== "completed" || entry.fingerprint !== fingerprint) throw new StoreDataError();

  return { kind, entry };
}

export function validateCommit(value: unknown, fingerprint: string, owner: Reservation): CommitResult {
  const kind = field(value, "kind");

  if (kind === "committed" || kind === "reservation-lost") return { kind };

  if (kind !== "already-committed") throw new StoreDataError();

  const entry = validateEntry(field(value, "entry"));

  if (entry.kind !== "completed" || entry.fingerprint !== fingerprint ||
      entry.reservationId !== owner.reservationId || entry.expiresAt !== owner.expiresAt) throw new StoreDataError();

  return { kind, entry };
}
