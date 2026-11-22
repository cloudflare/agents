/**
 * A stable string form of a value: object keys sorted, so two objects with
 * the same entries in another order give the same string. Meant for JSON
 * values; a `Date` is written as its ISO time so two dates tell apart.
 *
 * @internal
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) {
    return `Date(${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()})`;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value.toString()}n`;
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * A 128-bit hash of {@link stableStringify}. Not cryptographic: it tells
 * inputs apart, it does not hide them. The same function Think's action
 * ledger used, so rows it wrote still match.
 *
 * @internal
 */
export function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
