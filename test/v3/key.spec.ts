import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { assertClientKey, assertNamespace, assertScope, buildStorageKey } from "../../src/v3/key.js";
import { MemoryStore } from "../../src/v3/memory-store.js";
import { FINGERPRINT, response, start } from "../helpers/store-contract.js";

describe("v3 scoped storage keys", () => {
  it("KEY-09: hashes the exact JSON tuple with a versioned prefix", () => {
    const digest = createHash("sha256").update('["billing","tenant-A","key-1"]', "utf8").digest("hex");

    expect(buildStorageKey("billing", "tenant-A", "key-1")).toBe("idem:v3:" + digest);
  });

  it("does not expose raw identifiers in the physical key", () => {
    const key = buildStorageKey("billing", "private-user", "private-key");

    expect(key).toMatch(/^idem:v3:[a-f0-9]{64}$/);
    expect(key).not.toContain("private-user");
    expect(key).not.toContain("private-key");
  });

  it("KEY-09: preserves component boundaries instead of joining with a delimiter", () => {
    expect(buildStorageKey("billing", "tenant", "prefix:key"))
      .not.toBe(buildStorageKey("billing", "tenant:prefix", "key"));
    expect(buildStorageKey("billing", "tenant", "prefix|key"))
      .not.toBe(buildStorageKey("billing", "tenant|prefix", "key"));
  });

  it("does not normalize scope whitespace, Unicode or key case", () => {
    expect(buildStorageKey("billing", " user ", "key")).not.toBe(buildStorageKey("billing", "user", "key"));
    expect(buildStorageKey("billing", "é", "key")).not.toBe(buildStorageKey("billing", "e\u0301", "key"));
    expect(buildStorageKey("billing", "user", "KEY")).not.toBe(buildStorageKey("billing", "user", "key"));
    expect(buildStorageKey("billing", "\ud800", "key")).not.toBe(buildStorageKey("billing", "\udc00", "key"));
  });

  it.each([
    ["billing", "a".repeat(1024), "k".repeat(255)],
    ["n".repeat(128), "界".repeat(341), "key"],
    ["billing", "👩‍💻", "evt_123-ABC.:~"],
  ])("accepts exact identity limits and valid non-ASCII scopes", (namespace, scope, key) => {
    expect(buildStorageKey(namespace, scope, key)).toMatch(/^idem:v3:[a-f0-9]{64}$/);
  });

  it.each([undefined, null, "", "with space", "billing\n", "a/b", "a:b", "é", "a".repeat(129), 42])("rejects invalid namespace %j", (value) => {
    expect(() => assertNamespace(value)).toThrow(TypeError);
  });

  it.each([undefined, null, "", " \t", "user\n", "user\u007f", "user\u0085", "a".repeat(1025), "界".repeat(342), {}, Promise.resolve("user")])("rejects invalid scope %j", (value) => {
    expect(() => assertScope(value)).toThrow(TypeError);
  });

  it.each([undefined, null, "", "key with space", "key\n", "key\t", "key,other", '"key"', "é", "k".repeat(256), {}, Promise.resolve("key")])("rejects invalid client key %j", (value) => {
    expect(() => assertClientKey(value)).toThrow(TypeError);
  });

  it("buildStorageKey validates each identity rather than string-coercing invalid values", () => {
    expect(() => buildStorageKey(undefined as unknown as string, "user", "key")).toThrow(TypeError);
    expect(() => buildStorageKey("billing", null as unknown as string, "key")).toThrow(TypeError);
    expect(() => buildStorageKey("billing", "user", 123 as unknown as string)).toThrow(TypeError);
  });

  it("KEY-07/KEY-08: namespaces and scopes have independent reservations and replay results", async () => {
    const store = new MemoryStore();
    const identities = [
      ["billing", "user-A"],
      ["billing", "user-B"],
      ["another-app", "user-A"],
    ];
    const keys = identities.map(([namespace, scope]) => buildStorageKey(namespace, scope, "same-client-key"));

    for (let i = 0; i < keys.length; i++) {
      const owner = await start(store, keys[i]);

      await store.commit(keys[i], response({ body: Buffer.from(`owner-${i}`) }), owner.reservationId);
    }

    for (let i = 0; i < keys.length; i++) {
      const replay = await store.begin(keys[i], FINGERPRINT, 60_000);

      if (replay.kind !== "replay") throw new Error("Expected isolated replay");

      expect(replay.entry.cached.body.toString()).toBe(`owner-${i}`);
    }
  });
});
