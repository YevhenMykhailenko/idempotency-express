import type { Request } from "express";

export type HeaderMap = Record<string, string | string[]>;

export type CachedResponse = {
  status: number;
  body: string | Buffer;
  headers: HeaderMap;
  fingerprint: string;
  createdAt: number;
};

export type BeginResult =
  | { kind: "started" }
  | { kind: "replay"; cached: CachedResponse }
  | { kind: "conflict" }
  | { kind: "inflight" };

export interface Store {
  begin(key: string, fp: string, ttlMs: number): Promise<BeginResult>;
  commit(key: string, data: CachedResponse): Promise<void>;
  get(key: string): Promise<CachedResponse | null>;
  abort?(key: string, fp?: string): Promise<void>;
}

export type InFlightOptions = {
  strategy: "wait" | "reject";
  waitTimeoutMs?: number;
  pollMs?: number;
};

export type FingerprintOptions = {
  includeQuery?: boolean;          // default false
  maxBodyBytes?: number;           // default 64KB
  custom?: (req: Request) => string | undefined;
};

export type ReplayOptions = {
  headerWhitelist?: string[];      // lowercase header names
};

export type IdemOptions = {
  store: Store;
  ttlMs?: number;                   // default 24h
  methods?: string[];               // default ["POST"]
  keyHeader?: string;               // default "Idempotency-Key"
  requireKey?: boolean;             // default false
  inFlight?: InFlightOptions;       // default { strategy: "reject" }
  fingerprint?: FingerprintOptions;
  replay?: ReplayOptions;
};

export type Captured = {
  getBody: () => string | Buffer | undefined;
  restore: () => void;
  setOnSend: (cb: (status: number, body: string | Buffer) => void) => void;
  /** @deprecated Use setOnSend. */
  setOn?: (cb: (status: number, body: string | Buffer) => void) => void;
};
