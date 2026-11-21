import express from "express";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testHttpServer } from "./test-http-server.js";
import { createTenantApi, type Identity } from "../../examples/tenant-api.js";
import { createWebhookApp } from "../../examples/webhook-app.js";
import { idempotencyMiddleware, type Store } from "../../src/index.js";
import { buildStorageKey } from "../../src/v3/key.js";

export function runRecipeContract(name: string, create: () => { store: Store; close?: () => void | Promise<void> }) {
  describe(`${name} — application recipes`, () => {
    let store: Store;
    let close: (() => void | Promise<void>) | undefined;

    beforeEach(() => { ({ store, close } = create()); });
    afterEach(async () => { vi.restoreAllMocks(); await close?.(); });
    const orderKey = (identity: Identity, key = "key") => buildStorageKey("orders-recipe", JSON.stringify([identity.tenantId, identity.userId]), key);
    const alice = { tenantId: "tenant-one", userId: "alice" };

    async function tenant() {
      const tokens: Record<string, Identity> = {
        "Bearer old-token": alice, "Bearer refreshed-token": alice,
        "Bearer bob": { tenantId: "tenant-one", userId: "bob" },
        "Bearer another-tenant": { tenantId: "tenant-two", userId: "alice" },
      };
      let allowed = true;
      let limited = false;
      const authenticate = vi.fn((req: express.Request) => tokens[req.get("Authorization") ?? ""]);
      const authorize = vi.fn(async () => allowed);
      const effect = vi.fn(async ({ identity }: { identity: Identity }) => ({ id: `${identity.tenantId}/${identity.userId}` }));
      const app = createTenantApi({
        store, namespace: "orders-recipe", authenticate, authorize, createOrder: effect,
        rateLimit: (_req, res, next) => { if (limited) res.status(429).json({ error: "rate_limited" }); else next(); },
      });
      const { server } = await testHttpServer(app);
      const send = (token = "old-token", body: unknown = { amount: 100, currency: "USD" }) => request(server)
        .post("/orders").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", "key").send(body as object);

      return { app, send, effect, authenticate, authorize, allow: (value: boolean) => { allowed = value; }, limit: (value: boolean) => { limited = value; } };
    }

    it("KEY-10: token refresh preserves identity; authorization still runs before a cached reply", async () => {
      const api = await tenant();
      const first = await api.send();
      const replay = await api.send("refreshed-token").set("X-Tenant-ID", "unverified-tenant");

      expect(first.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers["idempotency-status"]).toBe("cached");
      expect(api.effect).toHaveBeenCalledTimes(1);
      expect(api.authenticate).toHaveBeenCalledTimes(2);
      expect(api.authorize).toHaveBeenCalledTimes(2);
      const before = await store.read(orderKey(alice));
      const begin = vi.spyOn(store, "begin");

      api.allow(false);
      expect((await api.send("refreshed-token")).status).toBe(403);
      expect(begin).not.toHaveBeenCalled();
      expect(await store.read(orderKey(alice))).toEqual(before);
    });

    it("KEY-07: separates user and tenant identities without trusting request tenant headers", async () => {
      const api = await tenant();
      const bodies = [];

      for (const token of ["old-token", "bob", "another-tenant"]) {
        const first = await api.send(token);
        const replay = await api.send(token);

        expect(first.status).toBe(201);
        expect(replay.headers["idempotency-status"]).toBe("cached");
        expect(replay.body).toEqual(first.body);
        bodies.push(first.body.id);
      }

      expect(new Set(bodies).size).toBe(3);
      expect(api.effect).toHaveBeenCalledTimes(3);
    });

    it("rejects authentication, validation and rate limits before claiming a key", async () => {
      const api = await tenant();
      const begin = vi.spyOn(store, "begin");

      expect((await api.send("invalid-token")).status).toBe(401);
      expect((await api.send("old-token", { amount: -1, currency: "USD" })).status).toBe(400);
      api.limit(true);
      expect((await api.send()).status).toBe(429);
      expect(begin).not.toHaveBeenCalled();
      expect(api.effect).not.toHaveBeenCalled();
      api.limit(false);
      expect((await api.send()).headers["idempotency-status"]).toBe("created");
      expect(api.effect).toHaveBeenCalledTimes(1);
    });

    it("passes a stable downstream key, but retains a completed 500 after a possible effect", async () => {
      const api = await tenant();

      api.effect.mockRejectedValue(new Error("private business provider URL"));
      const first = await api.send();
      const second = await api.send("refreshed-token");

      expect(first.status).toBe(500);
      expect(first.headers["idempotency-status"]).toBe("created");
      expect(second.status).toBe(500);
      expect(second.headers["idempotency-status"]).toBe("cached");
      expect(second.text).not.toContain("private business provider URL");
      expect(api.effect).toHaveBeenCalledTimes(1);
      const operation = api.effect.mock.calls[0][0] as { downstreamKey?: string };

      expect(operation.downstreamKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it("KEY-10 negative deployment: putting auth after idempotency can expose a private cached response", async () => {
      const app = express();

      app.use(express.json());
      const auth = vi.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.get("Authorization") !== "Bearer valid") res.sendStatus(401); else next();
      });

      app.post("/orders", idempotencyMiddleware({ store, namespace: "wrong-order-demo", scope: "unsafe-static-scope" }), auth,
        (_req, res) => { res.json({ private: "belongs to an authorized user" }); });
      const { server } = await testHttpServer(app);

      await request(server).post("/orders").set("Authorization", "Bearer valid").set("Idempotency-Key", "key").send({});
      const unsafe = await request(server).post("/orders").set("Idempotency-Key", "key").send({});

      expect(unsafe.status).toBe(200);
      expect(unsafe.body.private).toBe("belongs to an authorized user");
      expect(auth).toHaveBeenCalledTimes(1); // Deliberately WRONG app; the positive recipe avoids this ordering.
    });

    const now = 1_900_000_000_000;
    const secret = Buffer.alloc(32, 1);
    const rotated = Buffer.alloc(32, 2);
    const payload = JSON.stringify({ id: "evt_one", type: "invoice.paid", data: { amount: 100 } });

    async function webhook(accountId = "account-one", secrets = [secret]) {
      const effect = vi.fn(async () => undefined);
      const app = createWebhookApp({ store, namespace: "webhook-recipe", accountId, secrets, now: () => now, processEvent: effect });
      const { server } = await testHttpServer(app);
      const send = (body = payload, key = secret, timestamp = String(now / 1000)) => request(server).post("/webhook")
        .set("Content-Type", "application/json").set("X-Webhook-Timestamp", timestamp)
        .set("X-Webhook-Signature", "v1=" + createHmac("sha256", key).update(timestamp + ".").update(body).digest("hex"))
        .send(body);

      return { send, effect, rawRequest: () => request(server).post("/webhook") };
    }

    it("KEY-03: verified event ID is stable across delivery headers, timestamps and signature rotation", async () => {
      const firstApp = await webhook();

      expect((await firstApp.send().set("Idempotency-Key", "ignored-one")).status).toBe(204);
      const secondApp = await webhook("account-one", [rotated, secret]);
      const second = await secondApp.send(payload, rotated, String(now / 1000 + 10)).set("Idempotency-Key", "ignored-two");

      expect(second.status).toBe(204);
      expect(second.headers["idempotency-key"]).toBe("evt_one");
      expect(second.headers["idempotency-status"]).toBe("cached");
      expect(firstApp.effect).toHaveBeenCalledTimes(1);
      expect(secondApp.effect).not.toHaveBeenCalled();
    });

    it("checks freshness/signature on every retry, before reading a cached result", async () => {
      const api = await webhook();

      await api.send();
      const begin = vi.spyOn(store, "begin");

      expect((await api.send(payload, rotated)).status).toBe(401);
      expect((await api.send(payload, secret, String(now / 1000 - 301))).status).toBe(401);
      expect(begin).not.toHaveBeenCalled();
      expect(api.effect).toHaveBeenCalledTimes(1);
    });

    it("rejects compressed input instead of verifying a decompressed substitute for signed raw bytes", async () => {
      const api = await webhook();
      const begin = vi.spyOn(store, "begin");
      const timestamp = String(now / 1000);
      const result = await api.rawRequest().set("Content-Type", "application/json").set("Content-Encoding", "gzip")
        .set("X-Webhook-Timestamp", timestamp)
        .set("X-Webhook-Signature", "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(payload).digest("hex"))
        .send(gzipSync(payload));

      expect(result.status).toBe(415);
      expect(begin).not.toHaveBeenCalled(); expect(api.effect).not.toHaveBeenCalled();
    });

    it.each(["{", "[]", '{"id":123,"type":"paid","data":{}}', '{"id":"evt_one","type":"paid"}'])
      ("rejects signed but invalid event %j before claim, even with a fallback header", async (body) => {
        const api = await webhook();
        const begin = vi.spyOn(store, "begin");

        expect((await api.send(body).set("Idempotency-Key", "cannot-fallback")).status).toBe(400);
        expect(begin).not.toHaveBeenCalled();
        expect(api.effect).not.toHaveBeenCalled();
      });

    it("uses account scope from trusted server configuration, never an unsigned account header", async () => {
      const one = await webhook();
      const two = await webhook("account-two", [rotated]);

      expect((await one.send().set("X-Account-ID", "spoofed-account")).status).toBe(204);
      expect((await two.send(payload, rotated)).headers["idempotency-status"]).toBe("created");
      expect(one.effect).toHaveBeenCalledTimes(1);
      expect(two.effect).toHaveBeenCalledTimes(1);
    });

    it("conflicts on changed signed data for one event ID instead of executing it twice", async () => {
      const api = await webhook();

      await api.send();
      const changed = JSON.stringify({ id: "evt_one", type: "invoice.paid", data: { amount: 200 } });

      expect((await api.send(changed)).status).toBe(409);
      expect(api.effect).toHaveBeenCalledTimes(1);
    });

    it("retains a completed webhook error without leaking raw exception details", async () => {
      const api = await webhook();

      api.effect.mockRejectedValue(new Error("secret-webhook-connection"));
      expect((await api.send()).status).toBe(500);
      const replay = await api.send();

      expect(replay.status).toBe(500);
      expect(replay.headers["idempotency-status"]).toBe("cached");
      expect(replay.text).not.toContain("secret-webhook-connection");
      expect(api.effect).toHaveBeenCalledTimes(1);
    });
  });
}
