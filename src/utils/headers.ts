import type { HeaderMap } from "../types.js";

export function lowerCaseHeaders(h: Record<string, unknown>): HeaderMap {
  const out: HeaderMap = Object.create(null);

  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();

    if (v == null) continue;

    if (Array.isArray(v)) {
      out[key] = v.map((x) => String(x));
    } else {
      out[key] = String(v);
    }
  }

  return out;
}

export function filterHeaders(
  all: Record<string, unknown>,
  whitelist: string[]
): HeaderMap {
  const safe: HeaderMap = Object.create(null);
  const deny = connectionHeaders(all);
  const wl = new Set(whitelist.map((x) => x.toLowerCase()));

  for (const [k, v] of Object.entries(all)) {
    const key = k.toLowerCase();

    if (isForbiddenHeader(key) || deny.has(key) || v == null) continue;

    if (key === "content-type" || wl.has(key)) {
      safe[key] = Array.isArray(v) ? v.map(String) : String(v);
    }
  }

  return safe;
}

const FORBIDDEN = new Set([
  "authorization", "cookie", "connection", "content-encoding", "content-length",
  "keep-alive", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "www-authenticate",
]);

export function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();

  return FORBIDDEN.has(lower) || lower.startsWith("proxy-") || lower.startsWith("idempotency-");
}

function connectionHeaders(all: Record<string, unknown>): Set<string> {
  const names = new Set<string>();

  for (const [name, value] of Object.entries(all)) {
    if (name.toLowerCase() !== "connection") continue;

    const values = Array.isArray(value) ? value : [value];

    for (const item of values) {
      if (typeof item === "string") for (const token of item.split(",")) names.add(token.trim().toLowerCase());
    }
  }

  return names;
}

/** Pre-handler transport headers retained on a technical fault, never stored as cache data. */
export function faultHeaders(all: Record<string, unknown>): HeaderMap {
  const safe: HeaderMap = Object.create(null);
  const hop = connectionHeaders(all);
  const bodyHeaders = new Set([
    "content-type", "content-disposition", "content-range", "content-language", "content-location",
    "content-md5", "content-digest", "repr-digest", "digest", "accept-ranges",
    "etag", "location", "last-modified", "retry-after",
  ]);

  for (const [name, value] of Object.entries(all)) {
    const lower = name.toLowerCase();

    if (value != null && !isForbiddenHeader(lower) && !hop.has(lower) && !bodyHeaders.has(lower)) {
      safe[lower] = Array.isArray(value) ? value.map(String) : String(value);
    }
  }

  return safe;
}
