/**
 * Value serialization for the Fibers capability.
 *
 * Fiber inputs, step results, metadata, and final results persist as JSON
 * text in SQLite. `undefined` (and a `void` handler result) is represented
 * as SQL `NULL` rather than a JSON envelope, so the JSON column space stays
 * plain: `"null"` is JSON `null`, column `NULL` is `undefined`.
 */

import { FiberSerializationError } from "./errors";

/** Default ceiling for one serialized value (1 MiB). */
export const MAX_SERIALIZED_BYTES = 1_048_576;

const utf8 = new TextEncoder();

/**
 * Serialize one Fiber value for storage.
 *
 * @param value - The value to persist.
 * @param context - What is being serialized, for error messages
 * (e.g. `input for definition "report"`, `result of step "fetch"`).
 * @returns JSON text, or `null` when the value is `undefined`.
 * @throws FiberSerializationError when the value is not JSON-serializable or
 * its serialized form exceeds {@link MAX_SERIALIZED_BYTES}.
 */
export function serializeFiberValue(
  value: unknown,
  context: string
): string | null {
  if (value === undefined) return null;

  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new FiberSerializationError(
      context,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (json === undefined) {
    throw new FiberSerializationError(
      context,
      `value of type ${typeof value} has no JSON representation`
    );
  }

  const bytes = utf8.encode(json).byteLength;
  if (bytes > MAX_SERIALIZED_BYTES) {
    throw new FiberSerializationError(
      context,
      `serialized size ${bytes} bytes exceeds the ${MAX_SERIALIZED_BYTES}-byte limit`
    );
  }
  return json;
}

/**
 * Restore a value serialized by {@link serializeFiberValue}.
 *
 * @param stored - The stored column value.
 * @returns The original value; column `NULL` restores `undefined`.
 */
export function deserializeFiberValue(stored: string | null): unknown {
  if (stored === null) return undefined;
  return JSON.parse(stored);
}
