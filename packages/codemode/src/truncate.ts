/**
 * Result truncation utilities.
 *
 * Tool and sandbox results can be large enough to blow a model's context
 * window. These cap the serialized size of a value while leaving small,
 * structured results intact so the model can still reason over them. They are
 * the default building blocks for a `transformResult` hook (see
 * `createCodemodeRuntime`).
 *
 * Structured values are truncated structurally: the output is always valid
 * JSON of the same shape, with the largest values cut first. A truncated
 * string ends with a marker, a truncated array ends with a marker element
 * counting the dropped items, and an object that had to lose entries carries a
 * marker entry naming the omitted keys. Every marker contains
 * `--- TRUNCATED ---` so callers and models can find them.
 */

/** ~4 characters per token is a reasonable cross-model estimate. */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 6000;
const TRUNCATION_MARKER = "--- TRUNCATED ---";
/**
 * Below this many serialized characters a value cannot carry a useful prefix
 * plus a marker, so it is dropped in favour of its siblings instead.
 */
const MIN_SLOT = 48;

export type TruncateOptions = {
  /**
   * Maximum characters in the (serialized) output before truncation kicks in.
   * Defaults to `maxTokens * 4`.
   */
  maxChars?: number;
  /** Token budget used to derive the default `maxChars`. Defaults to 6000. */
  maxTokens?: number;
};

function budget(options?: TruncateOptions): {
  maxChars: number;
  maxTokens: number;
} {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = options?.maxChars ?? maxTokens * CHARS_PER_TOKEN;
  return { maxChars, maxTokens };
}

/**
 * Truncate a text response to a character budget, appending a marker that notes
 * the original size so the model knows the output was clipped. Returns the
 * input unchanged when it is within budget.
 */
export function truncateResponse(
  text: string,
  options?: TruncateOptions
): string {
  const { maxChars, maxTokens } = budget(options);
  if (text.length <= maxChars) return text;

  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return (
    text.slice(0, maxChars) +
    `\n\n${TRUNCATION_MARKER}\nResponse was ~${estimatedTokens.toLocaleString()} tokens ` +
    `(limit: ${maxTokens.toLocaleString()}). Narrow the request to reduce response size.`
  );
}

/**
 * Truncate a structured result. Strings are truncated directly. Other values
 * pass through unchanged (same reference) when their JSON serialization is
 * within budget. When oversized, the value is shrunk structurally — largest
 * values first, deepest last — so the model gets a bounded value that is still
 * valid JSON of the original shape, with markers where content was cut.
 *
 * Values that can't be serialized (cycles, bigint, `undefined`) are returned
 * unchanged.
 */
export function truncateResult(
  value: unknown,
  options?: TruncateOptions
): unknown {
  if (typeof value === "string") return truncateResponse(value, options);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return value;
  }
  if (serialized === undefined) return value;

  const { maxChars } = budget(options);
  if (serialized.length <= maxChars) return value;

  // Re-parse so `toJSON`, class instances and `undefined` members are seen in
  // their serialized form — the shape the model would receive anyway.
  const shrunk = shrink(JSON.parse(serialized) as Json, maxChars);
  // A value whose skeleton alone exceeds the budget (e.g. a tiny budget) falls
  // back to a clipped serialization so the cap still holds.
  return size(shrunk) <= maxChars
    ? shrunk
    : truncateResponse(serialized, options);
}

// ---------------------------------------------------------------------------
// Structural shrinking
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Serialized size in characters (compact JSON). */
function size(value: Json): number {
  return JSON.stringify(value).length;
}

/** Only strings and containers can give up characters; scalars are atomic. */
function shrinkable(value: Json): boolean {
  return typeof value === "string" || (typeof value === "object" && !!value);
}

function shrink(value: Json, maxChars: number): Json {
  if (size(value) <= maxChars) return value;
  if (typeof value === "string") return shrinkString(value, maxChars);
  if (Array.isArray(value)) return shrinkArray(value, maxChars);
  if (typeof value === "object" && value !== null) {
    return shrinkObject(value, maxChars);
  }
  return value;
}

function shrinkString(value: string, maxChars: number): string {
  const suffix = ` ${TRUNCATION_MARKER} ${value.length.toLocaleString()} chars`;
  let keep = Math.max(0, maxChars - suffix.length - 2);
  let out = value.slice(0, keep) + suffix;
  // Escapes inflate the serialized form; back off until it fits.
  while (keep > 0 && size(out) > maxChars) {
    keep = Math.floor(keep - (size(out) - maxChars) - 1);
    out = value.slice(0, Math.max(0, keep)) + suffix;
  }
  return out;
}

/**
 * Share `available` characters across values so small ones keep their full
 * size and the largest absorb the cut (water-filling). Returns `null` when
 * some value would be left with less than it can meaningfully use — a scalar
 * that does not fit, or a shrinkable value below {@link MIN_SLOT}.
 */
function allocate(values: Json[], available: number): number[] | null {
  const sizes = values.map(size);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const allocation = new Array<number>(values.length);
  let remaining = available;
  let count = values.length;
  for (const i of order) {
    const share = Math.floor(remaining / count);
    const alloc = Math.min(sizes[i], share);
    if (alloc < sizes[i] && (!shrinkable(values[i]) || alloc < MIN_SLOT)) {
      return null;
    }
    allocation[i] = alloc;
    remaining -= alloc;
    count--;
  }
  return allocation;
}

/** Largest `k` in `[0, max]` for which `feasible(k)` holds; feasibility is monotone. */
function largestFeasible(
  max: number,
  feasible: (k: number) => boolean
): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (feasible(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function shrinkArray(items: Json[], maxChars: number): Json[] {
  const marker = (dropped: number) =>
    `${TRUNCATION_MARKER} ${dropped.toLocaleString()} more items`;

  // Keep the longest prefix whose members can share the budget; the tail is
  // dropped because item order usually carries meaning (rows, pages, steps).
  const plan = (keep: number): number[] | null => {
    const dropped = items.length - keep;
    const tail = dropped > 0 ? size(marker(dropped)) + (keep > 0 ? 1 : 0) : 0;
    const overhead = 2 + Math.max(0, keep - 1) + tail;
    if (overhead > maxChars) return null;
    return allocate(items.slice(0, keep), maxChars - overhead);
  };

  const keep = largestFeasible(items.length, (k) => plan(k) !== null);
  const allocation = plan(keep) ?? [];
  const out = items
    .slice(0, keep)
    .map((item, i) => shrink(item, allocation[i]));
  if (keep < items.length) out.push(marker(items.length - keep));
  return out;
}

function shrinkObject(
  value: { [key: string]: Json },
  maxChars: number
): { [key: string]: Json } {
  const entries = Object.entries(value);
  const marker = (omitted: string[]) =>
    `${omitted.length.toLocaleString()} keys omitted: ${omitted.join(", ")}`;

  // Keys are all equally meaningful, so entries are dropped largest-first and
  // only when sharing the budget across the remaining values is impossible.
  const byValueSize = entries
    .map((entry, i) => ({ i, size: size(entry[1]) }))
    .sort((a, b) => b.size - a.size)
    .map((e) => e.i);

  const plan = (
    keep: number
  ): { kept: [string, Json][]; omitted: string[]; alloc: number[] } | null => {
    const omitted = byValueSize
      .slice(0, entries.length - keep)
      .sort((a, b) => a - b);
    const drop = new Set(omitted);
    const kept = entries.filter((_, i) => !drop.has(i));
    const omittedKeys = omitted.map((i) => entries[i][0]);
    const markerEntry: [string, Json][] =
      omittedKeys.length > 0 ? [[TRUNCATION_MARKER, marker(omittedKeys)]] : [];
    const all = [...kept, ...markerEntry];
    const overhead =
      2 +
      Math.max(0, all.length - 1) +
      all.reduce((n, [k]) => n + size(k) + 1, 0) +
      markerEntry.reduce((n, [, v]) => n + size(v), 0);
    if (overhead > maxChars) return null;
    const alloc = allocate(
      kept.map(([, v]) => v),
      maxChars - overhead
    );
    return alloc ? { kept, omitted: omittedKeys, alloc } : null;
  };

  const keep = largestFeasible(entries.length, (k) => plan(k) !== null);
  const chosen = plan(keep);
  if (!chosen) {
    return { [TRUNCATION_MARKER]: marker(entries.map(([k]) => k)) };
  }
  const out: { [key: string]: Json } = {};
  chosen.kept.forEach(([k, v], i) => {
    out[k] = shrink(v, chosen.alloc[i]);
  });
  if (chosen.omitted.length > 0) {
    out[TRUNCATION_MARKER] = marker(chosen.omitted);
  }
  return out;
}
