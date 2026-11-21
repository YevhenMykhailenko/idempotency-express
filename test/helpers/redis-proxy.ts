import { connect, createServer, type Socket } from "node:net";

import { deferred } from "./http-app.js";

/** Drops a real server reply only after Redis has sent it; never fakes successful execution. */
export async function redisAckProxy(targetUrl: string) {
  const target = new URL(targetUrl);

  if (target.protocol !== "redis:") throw new Error("The fault proxy supports test redis:// TCP URLs only");

  const sockets = new Set<Socket>();
  let armed = false;
  const dropped = deferred();
  const server = createServer((downstream) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port || 6379) });

    for (const socket of [upstream, downstream]) {
      sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); });
    }

    upstream.once("error", () => { downstream.destroy(); });
    downstream.once("error", () => { upstream.destroy(); });
    downstream.once("close", () => { upstream.destroy(); });
    downstream.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (armed) {
        armed = false;
        upstream.destroy(); downstream.destroy(); dropped.resolve();
      } else if (!downstream.write(chunk)) {
        upstream.pause(); downstream.once("drain", () => { upstream.resume(); });
      }
    });
    upstream.once("end", () => { downstream.end(); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Missing proxy address");

  const url = new URL(targetUrl);

  url.hostname = "127.0.0.1"; url.port = String(address.port);

  return {
    url: url.toString(), dropped: dropped.promise,
    arm: () => { armed = true; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      for (const socket of sockets) socket.destroy();
    }),
  };
}
