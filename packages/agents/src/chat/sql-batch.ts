/**
 * Helpers for building batched SQLite statements that run through the Agent's
 * `sql` tagged template (which interleaves a `?` placeholder between every
 * string fragment). Used to collapse per-row INSERT/DELETE loops into a small
 * number of multi-row statements.
 *
 * SQLite (Durable Object / D1) caps bound parameters at 100 per query, so
 * callers must chunk their inputs to stay within {@link MAX_BOUND_PARAMS}.
 * See https://developers.cloudflare.com/d1/platform/limits/
 */

/** Maximum bound parameters allowed in a single SQLite (DO / D1) query. */
export const MAX_BOUND_PARAMS = 100;

/**
 * Attach a self-referential `raw` property so a plain string[] satisfies the
 * TemplateStringsArray shape. `sql` only reads indexed string fragments, so
 * `raw` is never consumed — this just keeps the type system happy.
 */
function asTemplateStringsArray(parts: string[]): TemplateStringsArray {
  (parts as unknown as { raw: readonly string[] }).raw = parts;
  return parts as unknown as TemplateStringsArray;
}

/**
 * Build a TemplateStringsArray for a single-column `IN (...)` clause. Produces
 * fragments for:
 *   `${prefix}(?, ?, ...)`
 *
 * @throws if `count` is less than 1.
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
