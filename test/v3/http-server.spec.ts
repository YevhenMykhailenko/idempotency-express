import express from "express";
import { once } from "node:events";
import { connect } from "node:net";
import request from "supertest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { idempotencyMiddleware, MemoryStore } from "../../src/index.js";
import { deferred } from "../helpers/http-app.js";
import { testHttpServer } from "../helpers/test-http-server.js";

describe("test-owned HTTP listeners", () => {
  it("returns a ready IPv4 server and preserves Supertest chaining without automatic close", async () => {
    const http = await testHttpServer((_req, res) => { res.end("ready"); });

    expect(http.server.listening).toBe(true);
    expect(http.server.address()).toEqual(http.address);
    expect(http.address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(http.address.port).toBeGreaterThan(0);
    await request(http.server).get("/ready").set("X-Test", "one").expect(200, "ready");
    await request(http.server).get("/ready").expect(200, "ready");
    expect(http.server.listening).toBe(true);
    await http.close();
    await http.close();
    expect(http.server.listening).toBe(false);
    expect(http.server.address()).toBeNull();
  });

  it.each(["reset", "status"])("rejects an owned occupied IPv4 port without fallback or routing to its %s sentinel", async (action) => {
    let sentinelHits = 0;
    const sentinel = await testHttpServer((req, res) => {
      sentinelHits++;
      if (action === "reset") req.socket.destroy();
      else { res.statusCode = 501; res.end("owned-sentinel"); }
    });
    const store = new MemoryStore();
    const begin = vi.spyOn(store, "begin");
    const commit = vi.spyOn(store, "commit");
    const app = express();
    let requests = 0;
    let effects = 0;

    app.use((_req, _res, next) => { requests++; next(); });
    app.use(express.text());
    app.post("/orders", idempotencyMiddleware({
      store, namespace: "fingerprint-tests", scope: "public-test",
      fingerprint: { custom: (req) => req.get("X-Scope") },
    }), (req, res) => { res.status(201).json({ call: ++effects, body: req.body }); });

    await expect(testHttpServer(app, { port: sentinel.address.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(sentinelHits).toBe(0);
    expect(requests).toBe(0);
    expect(begin).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    const http = await testHttpServer(app);

    expect(http.address.port).not.toBe(sentinel.address.port);
    const first = await request(http.server).post("/orders").set("Idempotency-Key", "delimiter")
      .set("Content-Type", "text/plain").send('A|{"amount":100}').expect(201);
    const changed = await request(http.server).post("/orders").set("Idempotency-Key", "delimiter")
      .set("X-Scope", "A").set("Content-Type", "text/plain").send('{"amount":100}').expect(409);

    expect(first.body).toEqual({ call: 1, body: 'A|{"amount":100}' });
    expect(changed.headers["idempotency-status"]).toBe("conflict");
    expect(requests).toBe(2);
    expect(effects).toBe(1);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sentinelHits).toBe(0);
    await http.close();
    expect(sentinel.server.listening).toBe(true);
    const control = request(sentinel.server).get("/owned-control");

    if (action === "reset") await expect(control).rejects.toMatchObject({ code: "ECONNRESET" });
    else await control.expect(501, "owned-sentinel");

    expect(sentinelHits).toBe(1);
    expect(requests).toBe(2);
  });

  it.each(["unfinished", "upgraded"])("idempotent cleanup closes its own %s connection", async (mode) => {
    const entered = deferred();
    const http = await testHttpServer((_req, _res) => { entered.resolve(); });

    http.server.on("upgrade", () => { entered.resolve(); });
    const client = connect({ host: http.address.address, port: http.address.port });

    onTestFinished(() => { client.destroy(); });
    client.resume();
    const closed = once(client, "close");

    await once(client, "connect");
    client.write(mode === "upgraded"
      ? "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n"
      : "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await entered.promise;
    const closing = http.close();

    expect(http.close()).toBe(closing);
    await closing;
    await closed;
    expect(client.destroyed).toBe(true);
    expect(http.server.address()).toBeNull();
    expect(await new Promise<number>((resolve, reject) => {
      http.server.getConnections((error, count) => { if (error) reject(error); else resolve(count); });
    })).toBe(0);
  });

  for (const name of ["one", "two"]) {
    it.concurrent(`cleans up only its owning test's server at test finish (${name})`, async (context) => {
      // Finish hooks run in reverse order: verify after the helper's awaited cleanup.
      context.onTestFinished(() => {
        expect(http.server.listening).toBe(false);
        expect(http.server.address()).toBeNull();
      });
      const http = await testHttpServer((_req, res) => { res.end(name); }, context);

      await request(http.server).get("/").expect(200, name);
      expect(http.server.listening).toBe(true);
    });
  }
});
