import type { Response } from "express";

import type { Captured } from "../types.js";

export function captureResponse(res: Response): Captured {
  const originalSend: Response["send"] =
    (res.send.bind(res) as unknown) as Response["send"];
  const originalJson: Response["json"] =
    (res.json.bind(res) as unknown) as Response["json"];

  let capturedBody: string | Buffer | undefined;
  let onSend: ((status: number, body: string | Buffer) => void) | undefined;

  type SendArg = Parameters<Response["send"]>[0];
  type JsonArg = Parameters<Response["json"]>[0];

  type MutableResponse = Response & {
    send: (body?: SendArg) => Response;
    json: (body?: JsonArg) => Response;
  };
  const r = res as MutableResponse;

  r.send = function wrappedSend(this: Response, body?: SendArg): Response {
    let toCapture: string | Buffer;
    if (body === undefined) {
      toCapture = Buffer.from("");
    } else if (Buffer.isBuffer(body)) {
      toCapture = body;
    } else if (typeof body === "string") {
      toCapture = body;
    } else {
      toCapture = JSON.stringify(body);
    }

    capturedBody = toCapture;
    const status = this.statusCode || 200;
    onSend?.(status, toCapture);
    return originalSend(body);
  };

  r.json = function wrappedJson(this: Response, body?: JsonArg): Response {
    const toCapture = JSON.stringify(body === undefined ? null : body);
    capturedBody = toCapture;
    const status = this.statusCode || 200;
    onSend?.(status, toCapture);
    return originalJson(body);
  };

  return {
    getBody: () => capturedBody,
    restore: () => {
      (r as MutableResponse).send = originalSend;
      (r as MutableResponse).json = originalJson;
    },
    setOnSend: (cb: (status: number, body: string | Buffer) => void) => {
      onSend = cb;
    },
    setOn: (cb: (status: number, body: string | Buffer) => void) => {
      onSend = cb;
    },
  };
}
