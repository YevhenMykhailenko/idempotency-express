import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";

/** Owns one IPv4 listener and only the connections accepted by that listener. */
export async function listenHttpServer(handler: RequestListener, port = 0) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  };

  server.on("connection", track);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error?: NodeJS.ErrnoException) => {
        server.removeListener("connection", track);
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      // Also covers unfinished requests and upgraded sockets on this server only.
      for (const socket of sockets) socket.destroy();
    });

    return closing;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { server.removeListener("error", failed); resolve(); };
      const failed = (error: Error) => { server.removeListener("listening", ready); reject(error); };

      server.once("error", failed);
      server.once("listening", ready);
      server.listen(port, "127.0.0.1");
    });
    const address = server.address();

    if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
      throw new Error("Missing ready IPv4 test server address");
    }

    return { server, address, close };
  } catch (error) {
    await close();

    throw error;
  }
}
