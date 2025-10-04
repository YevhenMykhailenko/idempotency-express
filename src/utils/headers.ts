import type { HeaderMap } from "../types.js";

export function lowerCaseHeaders(h: Record<string, unknown>): HeaderMap {
  const out: HeaderMap = {};
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
  all: HeaderMap,
  whitelist: string[]
): HeaderMap {
  const safe: HeaderMap = {};
  const deny = new Set(["set-cookie", "authorization", "www-authenticate"]);
  const wl = new Set(whitelist.map((x) => x.toLowerCase()));

  for (const [k, v] of Object.entries(all)) {
    const key = k.toLowerCase();
    if (key === "content-length") continue; // нехай Node перерахує
    if (deny.has(key)) continue;
    if (key.startsWith("proxy-")) continue;

    if (key === "content-type" || wl.has(key)) {
      safe[key] = v;
    }
  }
  return safe;
}
