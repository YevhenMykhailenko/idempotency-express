import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export type WorkerMessage = { type: string; port?: number; kind?: string; count?: number; message?: string };

export async function redisWorker(options: { url: string; scope: string; effectKey: string; mode?: string; reject?: boolean; clockSkew?: number; recipe?: boolean }) {
  const child = fork(fileURLToPath(new URL(options.recipe ? "./tenant-worker.mjs" : "./redis-worker.mjs", import.meta.url)), [], {
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env, REDIS_URL: options.url, REDIS_WORKER_SCOPE: options.scope,
      REDIS_WORKER_EFFECT_KEY: options.effectKey, REDIS_WORKER_MODE: options.mode ?? "normal",
      REDIS_WORKER_REJECT: options.reject ? "1" : "0", REDIS_WORKER_CLOCK_SKEW: String(options.clockSkew ?? 0),
    },
  });
  const messages: WorkerMessage[] = [];
  let stderr = "";

  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const listeners = new Set<() => void>();

  child.on("message", (message: WorkerMessage) => { messages.push(message); for (const notify of listeners) notify(); });
  let ended = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { ended = true; for (const notify of listeners) notify();

    resolve(); }); });
  const waitFor = (predicate: (events: WorkerMessage[]) => boolean): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { finish(new Error(`Redis worker IPC deadline: ${stderr}`)); }, 10_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer); listeners.delete(notify);
      if (error) reject(error); else resolve();
    };

    const notify = (): void => {
      const fatal = messages.find((message) => message.type === "fatal");

      if (fatal) finish(new Error(fatal.message));
      else if (predicate(messages)) finish();
      else if (ended) finish(new Error(`Redis worker exited early: ${stderr}`));
    };

    listeners.add(notify); notify();
  });
  const kill = async (signal: NodeJS.Signals = "SIGTERM"): Promise<void> => { if (!ended) child.kill(signal);

    await exit; };

  try { await waitFor((events) => events.some((message) => message.type === "ready")); } catch (error) { await kill();

    throw error; }

  const port = messages.find((message) => message.type === "ready")?.port;

  if (!port) { await kill();

    throw new Error("Redis worker did not bind a port"); }

  return {
    messages, waitFor, kill, url: `http://127.0.0.1:${port}`,
    release: () => { child.send({ type: "release" }); }, revoke: () => { child.send({ type: "revoke" }); },
  };
}
