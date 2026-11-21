import { createHash } from "node:crypto";

import {
  MAX_CLIENT_KEY_BYTES,
  MAX_NAMESPACE_BYTES,
  MAX_SCOPE_BYTES,
  STORAGE_KEY_PREFIX,
} from "./limits.js";

export function assertNamespace(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_NAMESPACE_BYTES || /[^A-Za-z0-9._-]/.test(value)) {
    throw new TypeError("namespace must be 1-128 ASCII application identifier characters");
  }
}

export function assertScope(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 ||
      value.length > MAX_SCOPE_BYTES || Buffer.byteLength(value) > MAX_SCOPE_BYTES ||
      /\p{Cc}/u.test(value)) {
    throw new TypeError("scope must be a nonempty string of at most 1024 UTF-8 bytes without controls");
  }
}

export function assertClientKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_CLIENT_KEY_BYTES || /[^\x21-\x7e]|[",]/.test(value)) {
    throw new TypeError("key must be 1-255 printable ASCII characters without commas or quotes");
  }
}

export function buildStorageKey(namespace: string, scope: string, key: string): string {
  assertNamespace(namespace);
  assertScope(scope);
  assertClientKey(key);

  const digest = createHash("sha256")
    .update(JSON.stringify([namespace, scope, key]), "utf8")
    .digest("hex");

  return STORAGE_KEY_PREFIX + digest;
}
