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
 * The least a string or container is worth keeping at (see `floorSize`). A
 * value that would get fewer serialized characters than this is dropped in
 * favour of its siblings rather than reduced to a bare marker.
 */
const MIN_SLOT = 128;

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
  // `shrink` honours its budget for anything a container can hold; only a
  // scalar (a number too long for the budget) can still miss it.
  return size(shrunk) <= maxChars
    ? shrunk
    : truncateResponse(serialized, options);
}

// ---------------------------------------------------------------------------
// Structural shrinking
// ---------------------------------------------------------------------------
//
// Every `shrink*` below returns a value whose compact serialization fits the
// budget it was given, provided the budget can hold an empty container (2
// chars). Containers share their budget by water-filling: each child is owed
// at least its floor (`floorSize`), small children keep their full size, and
// the largest children absorb the cut. A container only drops children when
// even their floors cannot fit — arrays drop from the tail (order carries
// meaning), objects drop their largest values first (keys are all meaningful).

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Serialized size in characters (compact JSON). */
function size(value: Json): number {
  return JSON.stringify(value).length;
}

/** Only strings and containers can give up characters; scalars are atomic. */
function shrinkable(value: Json): boolean {
  return typeof value === "string" || (typeof value === "object" && !!value);
}

/**
 * The least budget a value is kept at; a scalar must fit whole. The floor
 * never exceeds half the container's own budget, so tiny budgets still keep
 * something rather than nothing.
 */
function floorSize(value: Json, maxChars: number): number {
  const full = size(value);
  return shrinkable(value)
    ? Math.min(full, MIN_SLOT, Math.max(2, Math.floor(maxChars / 2)))
    : full;
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
    keep = Math.max(0, keep - (size(out) - maxChars));
    out = value.slice(0, keep) + suffix;
  }
  // No room for a prefix and the size note: keep as much of the marker as fits.
  return size(out) <= maxChars
    ? out
    : TRUNCATION_MARKER.slice(0, Math.max(0, maxChars - 2));
}

/**
 * Share `available` characters across values by water-filling: values are
 * admitted smallest first, each taking the lesser of its full size and an
 * equal share of what is left. Requires `available >= Σ floorSize(values)`;
 * then every value receives at least its floor.
 */
function allocate(values: Json[], available: number): number[] {
  const sizes = values.map(size);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const allocation = new Array<number>(values.length);
  let remaining = available;
  let count = values.length;
  for (const i of order) {
    const alloc = Math.min(sizes[i], Math.floor(remaining / count));
    allocation[i] = alloc;
    remaining -= alloc;
    count--;
  }
  return allocation;
}

function shrinkArray(items: Json[], maxChars: number): Json[] {
  const marker = (dropped: number) =>
    `${TRUNCATION_MARKER} ${dropped.toLocaleString()} more items`;
  const floors = items.map((item) => floorSize(item, maxChars));
  const skeleton = (count: number) => 2 + Math.max(0, count - 1);

  // Keep everything when every floor fits.
  let keep = items.length;
  if (floors.reduce((n, f) => n + f, 0) + skeleton(keep) > maxChars) {
    // Otherwise keep the longest prefix whose floors fit beside a tail marker
    // (sized for the largest possible count, so the real one always fits).
    const tail = size(marker(items.length)) + 1;
    let used = skeleton(0) + tail;
    keep = 0;
    while (keep < items.length && used + floors[keep] + 1 <= maxChars) {
      used += floors[keep] + 1;
      keep++;
    }
  }

  const kept = items.slice(0, keep);
  const dropped = items.length - keep;
  const tail = dropped > 0 ? size(marker(dropped)) + (keep > 0 ? 1 : 0) : 0;
  const allocation = allocate(kept, maxChars - skeleton(keep) - tail);
  const out = kept.map((item, i) => shrink(item, allocation[i]));
  if (dropped > 0 && size([...out, marker(dropped)]) <= maxChars) {
    out.push(marker(dropped));
  }
  return out;
}

function shrinkObject(
  value: { [key: string]: Json },
  maxChars: number
): { [key: string]: Json } {
  const entries = Object.entries(value);
  // The marker entry must not shadow a real key.
  let markerKey = TRUNCATION_MARKER;
  while (markerKey in value) markerKey += " ";
  const keyCost = (key: string) => size(key) + 1;
  const floors = entries.map(([k, v]) => keyCost(k) + floorSize(v, maxChars));
  const floorOf = (chars: number) =>
    Math.min(chars, MIN_SLOT, Math.max(2, Math.floor(maxChars / 2)));

  // Drop the largest values first, only until the remaining floors fit. Costs
  // are tracked incrementally so a wide object stays linear in its key count;
  // the marker note's cost is derived arithmetically from the omitted names.
  const byValueSize = entries
    .map((_, i) => i)
    .sort((a, b) => size(entries[b][1]) - size(entries[a][1]));
  const dropped = new Set<number>();
  let present = entries.length;
  let floorsSum = floors.reduce((n, f) => n + f, 0);
  let namesLength = 0;
  const noteLength = () =>
    `${dropped.size.toLocaleString()} keys omitted: `.length +
    namesLength +
    2 * (dropped.size - 1);
  const cost = () => {
    const marker =
      dropped.size > 0 ? keyCost(markerKey) + floorOf(noteLength() + 2) : 0;
    const count = present + (dropped.size > 0 ? 1 : 0);
    return 2 + Math.max(0, count - 1) + floorsSum + marker;
  };
  for (const i of byValueSize) {
    if (cost() <= maxChars) break;
    dropped.add(i);
    present--;
    floorsSum -= floors[i];
    namesLength += size(entries[i][0]) - 2;
  }

  const kept = entries.filter((_, i) => !dropped.has(i));
  const omitted = [...dropped].sort((a, b) => a - b).map((i) => entries[i][0]);
  const note = `${omitted.length.toLocaleString()} keys omitted: ${omitted.join(", ")}`;
  if (cost() > maxChars) {
    // Not even the marker fits at its floor: keep as much of it as there is
    // room for, or nothing.
    const room = maxChars - 2 - keyCost(markerKey);
    return room >= 2 ? { [markerKey]: shrink(note, room) } : {};
  }
  const all: [string, Json][] = [...kept];
  if (omitted.length > 0) all.push([markerKey, note]);
  const fixed =
    2 + Math.max(0, all.length - 1) + all.reduce((n, [k]) => n + keyCost(k), 0);
  // The note is shrunk like any other value, so it can never overshoot.
  const allocation = allocate(
    all.map(([, v]) => v),
    maxChars - fixed
  );
  const out: { [key: string]: Json } = {};
  all.forEach(([k, v], i) => {
    out[k] = shrink(v, allocation[i]);
  });
  return out;
}
