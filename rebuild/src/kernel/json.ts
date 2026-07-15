import { toErrorValue, type ErrorValue } from "./errors.js";

export interface NormalizeReport<T> {
  value: T;
  /** True if normalization had to coerce a non-JSON-safe value (circular ref, BigInt, Symbol). */
  coerced: boolean;
}

/**
 * Deep-converts a value to plain JSON: drops functions, converts Dates to
 * ISO strings, and returns a detached deep copy. Non-JSON-safe values are
 * coerced rather than throwing: circular references become "[Circular]",
 * BigInts become "<n>n" strings, and Symbols become { type: "symbol" }.
 */
export function normalizeJson<T = unknown>(value: unknown): T {
  return normalizeJsonReport<T>(value).value;
}

/** Same as normalizeJson, but also reports whether coercion occurred. */
export function normalizeJsonReport<T = unknown>(value: unknown): NormalizeReport<T> {
  const seen = new WeakSet<object>();
  const state = { coerced: false };
  const result = normalize(value, seen, state) as T;
  return { value: result, coerced: state.coerced };
}

function normalize(value: unknown, seen: WeakSet<object>, state: { coerced: boolean }): unknown {
  if (value === undefined || typeof value === "function") {
    return undefined;
  }
  if (typeof value === "symbol") {
    state.coerced = true;
    return { type: "symbol" };
  }
  if (typeof value === "bigint") {
    state.coerced = true;
    return `${value.toString()}n`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    state.coerced = true;
    return "[Circular]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, seen, state) ?? null);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalize(v, seen, state);
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
