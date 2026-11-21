import type { Express } from "express";
import { createServer, request, type ClientRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";

export type HttpResult = { status: number; headers: IncomingHttpHeaders; body: Buffer };

/** Native client deliberately does not decompress or interpret response bytes. */
export async function serve(app: Express) {
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Missing test server address");

  const send = (options: RequestOptions = {}): { client: ClientRequest; result: Promise<HttpResult> } => {
    let client!: ClientRequest;
    const result = new Promise<HttpResult>((resolve, reject) => {
      client = request({
        hostname: "127.0.0.1", port: address.port, agent: false, method: "POST", path: "/orders",
        headers: { "Idempotency-Key": "key", "Content-Length": "0" }, ...options,
      }, (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        res.once("error", reject);
        res.once("end", () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }); });
      });
      client.once("error", reject);
      client.end();
    });

    return { client, result };
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    });
  };

  return { server, send, close };
}
