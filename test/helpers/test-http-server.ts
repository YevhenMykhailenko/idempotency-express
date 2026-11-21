import type { RequestListener } from "node:http";
import { onTestFinished, type TestContext } from "vitest";

import { listenHttpServer } from "./http-server.js";

type Options = { port?: number; onTestFinished?: TestContext["onTestFinished"] };

/** Concurrent tests must pass their context: the global Vitest hook is not async-local. */
export function testHttpServer(handler: RequestListener, options: Options = {}) {
  const finish = options.onTestFinished ?? onTestFinished;

  // Register ownership before opening the listener, including failed test/startup paths.
  finish(async () => {
    // Startup errors already fail the test; cleanup errors must still propagate.
    const http = await ready.catch(() => undefined);

    await http?.close();
  });
  const ready = listenHttpServer(handler, options.port);

  return ready;
}
