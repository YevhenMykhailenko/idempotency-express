import type { Request } from "express";
import { describe, expectTypeOf, it } from "vitest";

import type * as Public from "../../src/index.js";
import type { MemoryStore } from "../../src/v3/memory-store.js";
import type { CachedResponse, CommitResult, IdemOptions, KeyOptions, Store } from "../../src/v3/types.js";

type LegacyStore = {
  begin: (key: string, fingerprint: string, ttlMs: number) => Promise<{ kind: "started"; reservationId?: string }>;
  get: (key: string) => Promise<unknown>;
  commit: (key: string, data: unknown, reservationId?: string) => Promise<void>;
};

describe("v3 compile-time contract", () => {
  it("publishes the v3 Store and options through the package root", () => {
    expectTypeOf<Public.Store>().toEqualTypeOf<Store>();
    expectTypeOf<Public.IdemOptions>().toEqualTypeOf<IdemOptions>();
    expectTypeOf<Public.MemoryStore>().toEqualTypeOf<MemoryStore>();
    expectTypeOf<Public.ReplayOptions>().toEqualTypeOf<{ headerWhitelist?: string[] }>();
  });

  it("requires a reservation token and a byte Buffer on commit", () => {
    expectTypeOf<Parameters<Store["commit"]>>().toEqualTypeOf<[string, CachedResponse, string]>();
    expectTypeOf<ReturnType<Store["commit"]>>().toEqualTypeOf<Promise<CommitResult>>();
    expectTypeOf<CachedResponse["body"]>().toEqualTypeOf<Buffer>();
  });

  it("distinguishes Store v3 from v2 without an abort/release/get escape hatch", () => {
    expectTypeOf<MemoryStore>().toExtend<Store>();
    expectTypeOf<Store["protocolVersion"]>().toEqualTypeOf<3>();
    expectTypeOf<LegacyStore>().not.toExtend<Store>();
    expectTypeOf<Extract<keyof Store, "abort" | "release" | "get">>().toEqualTypeOf<never>();
  });

  it("requires namespace and scope while keeping key sources mutually exclusive", () => {
    expectTypeOf<Pick<IdemOptions, "namespace" | "scope">>().toEqualTypeOf<{
      namespace: string;
      scope: string | ((req: Request) => string);
    }>();
    expectTypeOf<{ getKey: (req: Request) => string; keyHeader: string }>().not.toExtend<KeyOptions>();
  });
});
