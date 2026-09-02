/**
 * Intake shaping: what a stored tool result is allowed to contribute to a
 * model request.
 *
 * Everything else that reduces context does it after the fact — a tool returns
 * three megabytes, it lands in the transcript, and a later pass trims, evicts
 * or summarizes it. This shapes on the way OUT of storage instead, so the
 * request never carries what the model was never going to use.
 *
 * ## Why this is safe for prompt caching, and sliding truncation is not
 *
 * A cache hit needs a byte-identical prefix. Dropping the oldest tool output
 * once a transcript passes some total size moves the boundary a little further
 * every turn, so the prefix is rewritten every turn and the cache never warms.
 *
 * The limits here are a function of ONE message and nothing else: how big that
 * tool result is, and which fields it carries. The same message shapes to the
 * same bytes on turn 3 and on turn 300, whatever surrounds it. The prefix is
 * stable, so the cache holds. That difference is the reason history shaping
 * stays with the hosts for now and this does not.
 *
 * ## Mechanism here, policy from the host
 *
 * Nothing in this module knows what any particular agent considers redundant.
 * Limits are supplied per call. The defaults are pi's, because they are the
 * ones measured against real agent workloads rather than chosen — but they are
 * defaults, not assumptions baked into the pipeline.
 *
 * @experimental The API surface may change before stabilizing.
 */

import type { SessionMessage, SessionMessagePart } from "../sessions";

/** Pi's text-read cap: whichever of the two comes first. */
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 50_000;
export const DEFAULT_MAX_TOOL_OUTPUT_LINES = 2_000;

/** How much of a tool result reaches the model. */
export interface IntakeLimits {
  /** Serialized ceiling for one tool result's text. Default 50,000. */
  maxBytes?: number;
  /** Line ceiling for one tool result's text. Default 2,000. */
  maxLines?: number;
  /**
   * Fields to strip from a tool part before it reaches the model.
   *
   * Harnesses commonly persist a raw provider payload beside the content they
   * actually render — useful to keep, pointless to send. Naming those fields
   * is the host's call, because only the host knows which of its own fields
   * are duplicates.
   */
  dropFields?: readonly string[];
  /**
   * Notice appended in place of what was cut. The default names the byte
   * offset to resume from, so the model can read the rest deliberately rather
   * than hitting a silent dead end — which is what makes an aggressive cap
   * safe rather than lossy in practice.
   */
  continuation?: (info: TruncationInfo) => string;
}

export interface TruncationInfo {
  /** Bytes removed from this value. */
  droppedBytes: number;
  /** Byte offset the untruncated content continues at. */
  nextOffset: number;
  /** Lines removed, when the line cap is what cut it. */
  droppedLines: number;
}

function defaultContinuation(info: TruncationInfo): string {
  return `\n\n[${info.droppedBytes} bytes truncated; continue from offset=${info.nextOffset}]`;
}

function isToolPart(part: SessionMessagePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Cut a string to the first limit it crosses, appending a continuation notice.
 * Returns the input unchanged when it is already within both limits.
 */
export function capText(value: string, limits: IntakeLimits = {}): string {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
  const maxLines = limits.maxLines ?? DEFAULT_MAX_TOOL_OUTPUT_LINES;
  const total = byteLength(value);

  let cut = value.length;
  let droppedLines = 0;
  if (maxLines > 0) {
    let line = 0;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) !== 10) continue;
      line++;
      if (line === maxLines) {
        cut = i;
        break;
      }
    }
    if (cut < value.length) {
      for (let i = cut; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) droppedLines++;
      }
    }
  }

  let head = value.slice(0, cut);
  if (byteLength(head) > maxBytes) {
    // Trim by bytes without splitting a surrogate pair, so the result is
    // always valid UTF-8 no matter where the budget lands.
    let end = head.length;
    while (end > 0 && byteLength(head.slice(0, end)) > maxBytes) end--;
    const code = head.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    head = head.slice(0, end);
    droppedLines = 0;
    for (let i = head.length; i < value.length; i++) {
      if (value.charCodeAt(i) === 10) droppedLines++;
    }
  }

  if (head.length === value.length) return value;

  const kept = byteLength(head);
  const notice = limits.continuation ?? defaultContinuation;
  return (
    head +
    notice({ droppedBytes: total - kept, nextOffset: kept, droppedLines })
  );
}

function shapeValue(
  value: unknown,
  limits: IntakeLimits,
  depth: number
): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") return capText(value, limits);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const shaped = shapeValue(entry, limits, depth + 1);
      if (shaped !== entry) changed = true;
      return shaped;
    });
    return changed ? next : value;
  }
  if (value === null || typeof value !== "object") return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const shaped = shapeValue(entry, limits, depth + 1);
    if (shaped !== entry) changed = true;
    next[key] = shaped;
  }
  return changed ? next : value;
}

/**
 * Apply the limits to every tool result in one message.
 *
 * Returns the message by reference when nothing needed shaping, so a
 * transcript of ordinary text costs a walk and no allocation.
 */
export function shapeMessage(
  message: SessionMessage,
  limits: IntakeLimits = {}
): SessionMessage {
  const drop = limits.dropFields ?? [];
  let changed = false;

  const parts = message.parts.map((part) => {
    if (!isToolPart(part)) return part;

    let next: SessionMessagePart = part;
    for (const field of drop) {
      if (field in next) {
        if (next === part) next = { ...part };
        // SAFETY: dropping a host-named field from a copy of the part; the
        // part type does not model host extensions, which is what `dropFields`
        // exists to remove.
        delete (next as unknown as Record<string, unknown>)[field];
        changed = true;
      }
    }

    for (const key of ["output", "result"] as const) {
      const value = next[key];
      if (value === undefined) continue;
      const shaped = shapeValue(value, limits, 0);
      if (shaped === value) continue;
      if (next === part) next = { ...part };
      next[key] = shaped;
      changed = true;
    }
    return next;
  });

  return changed ? { ...message, parts } : message;
}

/** Shape a streamed history without materializing it. */
export async function* shapeHistory(
  source: AsyncIterable<SessionMessage>,
  limits: IntakeLimits = {}
): AsyncGenerator<SessionMessage, void, undefined> {
  for await (const message of source) yield shapeMessage(message, limits);
}
