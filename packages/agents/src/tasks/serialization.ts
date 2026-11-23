/**
 * Value serialization for the Tasks capability.
 *
 * Task inputs, step results, metadata, and final results persist as JSON
 * text in SQLite. `undefined` (and a `void` handler result) is represented
 * as SQL `NULL` rather than a JSON envelope, so the JSON column space stays
 * plain: `"null"` is JSON `null`, column `NULL` is `undefined`.
 */

import { TaskSerializationError } from "./errors";

/** Default ceiling for one serialized value (1 MiB). */
export const MAX_SERIALIZED_BYTES = 1_048_576;

const utf8 = new TextEncoder();

/**
 * Serialize one Task value for storage.
 *
 * @param value - The value to persist.
 * @param context - What is being serialized, for error messages
 * (e.g. `input for definition "report"`, `result of step "fetch"`).
 * @returns JSON text, or `null` when the value is `undefined`.
 * @throws TaskSerializationError when the value is not JSON-serializable or
 * its serialized form exceeds {@link MAX_SERIALIZED_BYTES}.
 */
export function serializeTaskValue(
  value: unknown,
  context: string,
  maxBytes = MAX_SERIALIZED_BYTES
): string | null {
  if (value === undefined) return null;

  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TaskSerializationError(
      context,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (json === undefined) {
    throw new TaskSerializationError(
      context,
      `value of type ${typeof value} has no JSON representation`
    );
  }

  const bytes = utf8.encode(json).byteLength;
  if (bytes > maxBytes) {
    throw new TaskSerializationError(
      context,
      `serialized size ${bytes} bytes exceeds the ${maxBytes}-byte limit`
    );
  }
  return json;
}

/**
 * Restore a value serialized by {@link serializeTaskValue}.
 *
 * @param stored - The stored column value.
 * @returns The original value; column `NULL` restores `undefined`.
 */
export function deserializeTaskValue(stored: string | null): unknown {
  if (stored === null) return undefined;
  return JSON.parse(stored);
}

/**
 * Largest input a framework definition's run may take (`Tasks.register`):
 * past one row's room it is stored in pieces (`cf_agents_task_parts`).
 */
export const MAX_PARTED_INPUT_BYTES = 16 * 1_048_576;

/**
 * Longest input kept in the run's own row, in UTF-16 code units: SQLite
 * stores a row in at most 2 MB, which the run's other columns share.
 */
export const INLINE_INPUT_UNITS = 500_000;

/**
 * `text` in pieces of at most `size` code units, never between the two
 * halves of a surrogate pair: SQLite stores text as UTF-8, which cannot
 * hold half a pair.
 */
export function splitPieces(text: string, size: number): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}
