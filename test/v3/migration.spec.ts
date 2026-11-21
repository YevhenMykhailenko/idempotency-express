import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { idempotencyMiddleware, MemoryStore } from "../../src/index.js";
import { buildStorageKey } from "../../src/v3/key.js";
import { testHttpServer } from "../helpers/test-http-server.js";

/** Deployment-policy model for docs/migration.md, NOT a library migration bridge or production cutover proof. */
describe("conservative migration runbook gates", () => {
  it("MIG-01: an empty v3 key cannot bypass the operator's stop/drain/retention/reconciliation gate", async () => {
    const legacy = new Map([["old-key", { state: "done", expiry: 10_000, data: { body: "legacy private response" } }]]);
    const before = structuredClone(legacy.get("old-key"));
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const newKey = buildStorageKey("migration-demo", "authorized-user", "old-key");

    expect(await store.read(newKey)).toBeNull(); // Not evidence that the raw legacy key was unused.
    let now = 1000;
    const state = { oldWritersStopped: false, inflight: 1, latestLegacyExpiry: 10_000, reconciliationApproved: false };
    const app = express();

    app.use((_req, res, next) => {
      if (!state.oldWritersStopped || state.inflight !== 0 || now < state.latestLegacyExpiry || !state.reconciliationApproved) {
        res.status(503).json({ error: "migration_in_progress" });

        return;
      }

      next();
    });
    app.post("/orders", idempotencyMiddleware({ store, namespace: "migration-demo", scope: "authorized-user" }),
      (_req, res) => { res.status(201).json({ id: "new-approved-intent" }); });
    const { server } = await testHttpServer(app);
    const send = (key = "old-key") => request(server).post("/orders").set("Idempotency-Key", key);

    expect((await send()).status).toBe(503);
    state.oldWritersStopped = true; now = 10_000;
    expect((await send()).status).toBe(503); // Retention elapsed, but an old handler is not drained.
    state.inflight = 0;
    expect((await send()).status).toBe(503); // TTL alone does not resolve external business effects.
    expect(begin).not.toHaveBeenCalled();
    expect(legacy.get("old-key")).toEqual(before); // No flush/import/repair/release of legacy records.
    state.reconciliationApproved = true;
    expect((await send("new-approved-intent")).status).toBe(201);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("MIG-02: an unscoped legacy body is never promoted into another identity's response", async () => {
    const legacy = new Map([["known-key", { status: 201, body: { privateOwner: "unknown-legacy-user" }, expiry: 10_000 }]]);
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const commit = vi.spyOn(store, "commit");
    const app = express();

    app.post("/orders", (req, res, next) => {
      // While legacy retention is live, hold the route rather than guessing identity or copying the body.
      if (legacy.has(req.get("Idempotency-Key") ?? "")) { res.status(503).json({ error: "migration_in_progress" });

        return; }

      next();
    }, idempotencyMiddleware({ store, namespace: "migration-demo", scope: "another-user" }), (_req, res) => { res.json({ ok: true }); });
    const { server } = await testHttpServer(app);
    const response = await request(server).post("/orders").set("Idempotency-Key", "known-key");

    expect(response.status).toBe(503);
    expect(response.text).not.toContain("unknown-legacy-user");
    expect(begin).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(await store.read(buildStorageKey("migration-demo", "another-user", "known-key"))).toBeNull();
    expect(legacy.has("known-key")).toBe(true);
  });
});
