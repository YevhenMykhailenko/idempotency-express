import type { Response } from "express";

import type { Captured } from "../types.js";

export function captureResponse(res: Response): Captured {
  type MutableResponse = {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => Response;
  };
  const mutable = res as unknown as MutableResponse;
  const originalWrite = mutable.write.bind(res);
  const originalEnd = mutable.end.bind(res);

  let streamed = false;
  let capturedBody: Buffer | undefined;
  let onSend: ((status: number, body: string | Buffer) => void) | undefined;

  mutable.write = (...args: unknown[]): boolean => {
    streamed = true;
    return originalWrite(...args);
  };

  mutable.end = (...args: unknown[]): Response => {
    if (!streamed) {
      capturedBody = endBody(args[0], args[1]);
      if (capturedBody) onSend?.(res.statusCode || 200, capturedBody);
    }
    return originalEnd(...args);
  };

  return {
    getBody: () => capturedBody,
    restore: () => {
      mutable.write = originalWrite;
      mutable.end = originalEnd;
    },
    setOnSend: (cb) => { onSend = cb; },
    setOn: (cb) => { onSend = cb; },
  };
}

function endBody(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === "function") {
    return Buffer.alloc(0);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  }
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return undefined;
}
