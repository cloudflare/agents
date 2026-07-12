import { toErrorValue, type ErrorValue } from "./errors.js";

/**
 * Deep-converts a value to plain JSON: drops functions, converts Dates to
 * ISO strings, and returns a detached deep copy. Throws on cyclic values.
 */
export function normalizeJson<T = unknown>(value: unknown): T {
  const seen = new WeakSet<object>();
  return normalize(value, seen) as T;
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    throw new Error("normalizeJson: cyclic value");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, seen) ?? null);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalize(v, seen);
      if (normalized !== undefined) result[k] = normalized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function tryNormalizeJson(
  value: unknown
): { ok: true; value: unknown } | { ok: false; error: ErrorValue } {
  try {
    return { ok: true, value: normalizeJson(value) };
  } catch (err) {
    return { ok: false, error: toErrorValue(err) };
  }
}

/**
 * Truncates text to at most `maxChars` characters, appending a trailing
 * marker noting how many characters were elided.
 */
export function truncateForModel(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const elided = text.length - maxChars;
  const marker = `\n…[truncated ${elided} characters]`;
  return { text: text.slice(0, maxChars) + marker, truncated: true };
}

/** UTF-8 byte length of the JSON-serialized value. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
