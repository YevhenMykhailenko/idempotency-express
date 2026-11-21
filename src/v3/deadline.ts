import { performance } from "node:perf_hooks";

export const monotonicNow = (): number => performance.now();
export class DeadlineError extends Error {}
export class DisconnectedError extends Error {}

/** A local deadline never cancels a backend operation; always observe its late settlement. */
export function withDeadline<T>(call: () => T | Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = monotonicNow();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };

    const abort = (): void => { finish(undefined, new DisconnectedError()); };
    const expire = (): void => {
      const remaining = timeoutMs - (monotonicNow() - start);

      if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
      else finish(undefined, new DeadlineError());
    };

    if (signal?.aborted) { abort();

      return; }

    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(expire, Math.max(1, Math.ceil(timeoutMs)));
    try {
      Promise.resolve(call()).then(
        (value) => {
          if (monotonicNow() - start >= timeoutMs) finish(undefined, new DeadlineError());
          else finish(value);
        },
        (error: unknown) => {
          finish(undefined, monotonicNow() - start >= timeoutMs ? new DeadlineError()
            : error === undefined ? new Error("Store operation failed") : error);
        },
      );
    } catch (error) {
      finish(undefined, error === undefined ? new Error("Store operation failed") : error);
    }
  });
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await withDeadline(() => new Promise<void>((resolve) => {
    const timer = setTimeout(done, Math.max(1, Math.ceil(ms)));

    function done() { signal.removeEventListener("abort", cancel); resolve(); }

    function cancel() { clearTimeout(timer); done(); }

    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }), 2_147_483_647, signal);
}
