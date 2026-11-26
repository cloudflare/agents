/**
 * Kept only for released `@cloudflare/think` 0.24.0, which imports
 * `buildInClauseStrings` from `agents/chat`; nothing in this repo calls it.
 */

function asTemplateStringsArray(parts: string[]): TemplateStringsArray {
  (parts as unknown as { raw: readonly string[] }).raw = parts;
  return parts as unknown as TemplateStringsArray;
}

/**
 * Build a TemplateStringsArray for a single-column `IN (...)` clause:
 * `${prefix}(?, ?, ...)` with `count` placeholders.
 *
 * @throws if `count` is less than 1.
 * @internal Kept for released `@cloudflare/think` 0.24.0, which imports it.
 * @deprecated
 */
export function buildInClauseStrings(
  prefix: string,
  count: number
): TemplateStringsArray {
  if (count < 1) {
    throw new Error(`buildInClauseStrings requires count >= 1 (got ${count})`);
  }
  const parts = new Array<string>(count + 1);
  parts[0] = `${prefix}(`;
  for (let i = 1; i < count; i++) {
    parts[i] = ", ";
  }
  parts[count] = ")";
  return asTemplateStringsArray(parts);
}
