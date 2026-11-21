import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { connectRedis } from "./redis.js";

const docker = promisify(execFile);

/** Owns exactly one disposable container and its anonymous volume; never controls REDIS_URL. */
export async function disposableRedis() {
  const { stdout } = await docker("docker", [
    "run", "--detach", "--pull=never", "--name", `idem-durability-${randomUUID()}`,
    "--publish", "127.0.0.1::6379", process.env.REDIS_TEST_IMAGE ?? "redis:7-alpine",
    "redis-server", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction",
  ]);
  const id = stdout.trim();

  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid disposable container ID");

  const close = async () => { await docker("docker", ["rm", "--force", "--volumes", id]); };

  try {
    const address = async () => {
      const { stdout: ports } = await docker("docker", ["port", id, "6379/tcp"]);
      const port = ports.match(/^127\.0\.0\.1:(\d+)$/m)?.[1];

      if (!port) throw new Error("Missing disposable Redis port");

      return `redis://127.0.0.1:${port}`;
    };

    let url = await address();
    const ready = async () => {
      const deadline = performance.now() + 10_000;

      while (true) {
        try { const client = await connectRedis(url);

          await client.ping(); await client.close();

          return; } catch (error) {
          if (performance.now() >= deadline) throw error;

          await sleep(25);
        }
      }
    };

    await ready();

    return {
      get url() { return url; }, close,
      restart: async () => {
        await docker("docker", ["restart", "--time", "1", id]);
        // Docker may allocate a different dynamic host port on restart.
        url = await address(); await ready();
      },
    };
  } catch (error) { await close();

    throw error; }
}
