export interface IdSource {
  newId(prefix: string): string;
}

function randomSuffix(): string {
  // crypto.randomUUID() without dashes, URL-safe.
  return crypto.randomUUID().replace(/-/g, "");
}

export const defaultIdSource: IdSource = {
  newId(prefix: string): string {
    return `${prefix}_${randomSuffix()}`;
  },
};

/**
 * Produces a canonical JSON string: object keys sorted recursively, arrays
 * left in their original order, `undefined` properties dropped. Stable
 * across processes and key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const result: Record<string, unknown> = {};
  for (const [k, v] of entries) result[k] = canonicalize(v);
  return result;
}

/**
 * Deterministic, key-order-independent hash of a JSON-serializable value.
 * FNV-1a 64-bit over the canonical JSON representation, hex-encoded.
 */
export function stableHash(value: unknown): string {
  const input = canonicalJson(value);
  // FNV-1a 64-bit, implemented with BigInt for portability across JS engines.
  const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK64 = 0xffffffffffffffffn;
  let hash = FNV_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}
