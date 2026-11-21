import type { Request } from "express";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildFingerprint } from "../../src/utils/fingerprint.js";
import type { FingerprintOptions } from "../../src/v3/types.js";

type Vector = {
  id: string;
  method: string;
  url: string;
  body:
    | { kind: "json"; raw: string }
    | { kind: "text"; text: string }
    | { kind: "buffer"; hex: string }
    | { kind: "absent" };
  query?: Record<string, string | string[]>;
  options?: { includeQuery?: boolean; custom?: string };
  expectedHash: string;
};

const fixture = JSON.parse(readFileSync(new URL("../fixtures/fingerprint-v2.json", import.meta.url), "utf8")) as {
  fingerprintFormat: string;
  vectors: Vector[];
};

describe("v3 migration — frozen fingerprint format 2", () => {
  it("loads a fixed set of 15 baseline vectors independent of agent-local plans", () => {
    expect(fixture.fingerprintFormat).toBe("express-idempotency-middleware:2");
    expect(fixture.vectors).toHaveLength(15);
    expect(new Set(fixture.vectors.map((vector) => vector.id)).size).toBe(15);
  });

  it.each(fixture.vectors)("META-01: $id keeps its recorded hash", (vector) => {
    let body: unknown;

    if (vector.body.kind === "json") body = JSON.parse(vector.body.raw);
    else if (vector.body.kind === "text") body = vector.body.text;
    else if (vector.body.kind === "buffer") body = Buffer.from(vector.body.hex, "hex");

    const req = {
      method: vector.method,
      originalUrl: vector.url,
      query: vector.query,
      body,
    } as Request;
    const options: FingerprintOptions = { includeQuery: vector.options?.includeQuery };

    if (vector.options && Object.hasOwn(vector.options, "custom")) {
      options.custom = () => vector.options?.custom;
    }

    expect(vector.expectedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildFingerprint(req, options)).toBe(vector.expectedHash);
  });
});
