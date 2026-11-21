import type { Request } from "express";

export type HeaderMap = Record<string, string | string[]>;

export type CachedResponse = {
  status: number;
  body: Buffer;
  headers: HeaderMap;
  fingerprint: string;
  createdAt: number;
};

export type Reservation = {
  reservationId: string;
  expiresAt: number;
};

export type InflightEntry = Reservation & {
  kind: "inflight";
  fingerprint: string;
};

export type CompletedEntry = Reservation & {
  kind: "completed";
  fingerprint: string;
  cached: CachedResponse;
};

export type StoreEntry = InflightEntry | CompletedEntry;

export type BeginResult =
  | (Reservation & { kind: "started" })
  | (Reservation & { kind: "inflight" })
  | { kind: "replay"; entry: CompletedEntry }
  | { kind: "conflict" };

export type CommitResult =
  | { kind: "committed" }
  | { kind: "already-committed"; entry: CompletedEntry }
  | { kind: "reservation-lost" };

export interface Store {
  readonly protocolVersion: 3;
  begin(key: string, fingerprint: string, ttlMs: number): Promise<BeginResult>;
  read(key: string): Promise<StoreEntry | null>;
  commit(key: string, data: CachedResponse, reservationId: string): Promise<CommitResult>;
}

export type FingerprintOptions = {
  includeQuery?: boolean;
  maxBodyBytes?: number;
  custom?: (req: Request) => string | undefined;
};

export type InFlightOptions = {
  strategy: "wait" | "reject";
  waitTimeoutMs?: number;
  pollMs?: number;
};

export type IdempotencyEvent = {
  type: "started" | "completed" | "replayed" | "conflict" | "inflight"
    | "wait-timeout" | "store-error" | "outcome-unknown" | "bypassed";
  operation?: "begin" | "read" | "commit";
  code?: string;
  status?: number;
  durationMs?: number;
};

export type KeyOptions =
  | { keyHeader?: string; getKey?: never }
  | { getKey: (req: Request) => string | undefined; keyHeader?: never };

export type ReplayOptions = { headerWhitelist?: string[] };

export type IdemOptions = KeyOptions & {
  store: Store;
  namespace: string;
  scope: string | ((req: Request) => string);
  ttlMs?: number;
  methods?: string[];
  requireKey?: boolean;
  storeTimeoutMs?: number;
  maxResponseBytes?: number;
  inFlight?: InFlightOptions;
  fingerprint?: FingerprintOptions;
  replay?: ReplayOptions;
  onEvent?: (event: IdempotencyEvent) => void | Promise<void>;
};

export type MemoryStoreOptions = { maxEntries?: number };
