import type { Request } from "express";
import crypto from "node:crypto";

import type { FingerprintOptions } from "../types.js";

export function buildFingerprint(req: Request, opts?: FingerprintOptions): string {
  const includeQuery = !!opts?.includeQuery;
  const maxBodyBytes = opts?.maxBodyBytes ?? 64 * 1024;

  const method = (req.method || "GET").toUpperCase();
  const pathOnly = (req.originalUrl || (req as Request).path || "/").split("?")[0] || "/";

  const parts: string[] = [];
  parts.push(method);
  parts.push(pathOnly);

  if (includeQuery) {
    const raw = req.query as Record<string, unknown>;
    const entries = Object.entries(raw || {}).map(([k, v]) => [k, String(v)]);
    const sorted = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    parts.push(JSON.stringify(sorted));
  }

  const custom = opts?.custom?.(req);
  if (custom) parts.push(custom);

  let bodyStr = "";
  const body: unknown = (req as Request & { body?: unknown }).body;
  if (body === undefined || body === null) {
    bodyStr = "";
  } else if (typeof body === "string") {
    bodyStr = body;
  } else if (Buffer.isBuffer(body)) {
    bodyStr = body.toString("utf8");
  } else if (typeof body === "object") {
    bodyStr = stableStringify(body);
  } else {
    bodyStr = String(body);
  }

  if (bodyStr.length > maxBodyBytes) bodyStr = bodyStr.slice(0, maxBodyBytes);

  const fpRaw = parts.join("|") + "|" + bodyStr;
  return sha256(fpRaw);
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function stableStringify(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

function sortDeep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortDeep);
  if (x && typeof x === "object") {
    const rec = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) {
      const v = rec[k];
      out[k] = typeof v === "string" ? v.trim() : sortDeep(v);
    }
    return out;
  }
  return x;
}
