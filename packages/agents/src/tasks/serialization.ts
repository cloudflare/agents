/**
 * Value serialization for the Tasks capability.
 *
 * Task inputs, step results, metadata, and final results persist as JSON
 * text in SQLite. `undefined` (and a `void` handler result) is represented
 * as SQL `NULL` rather than a JSON envelope, so the JSON column space stays
 * plain: `"null"` is JSON `null`, column `NULL` is `undefined`.
 */

import { TaskCheckpointTooLargeError, TaskSerializationError } from "./errors";
import { isCompiledCheckpoint } from "./machine";

/** Default ceiling for one serialized value (1 MiB). */
export const MAX_SERIALIZED_BYTES = 1_048_576;

/**
 * Ceiling for one serialized checkpoint (256 KiB) — deliberately a quarter
 * of the value ceiling. A one-shot input is written once; a checkpoint is
 * re-serialized and re-written on every transition, so the tighter bound is
 * the point at which a growing state becomes a cost problem rather than a
 * correctness one, and it fails early enough to be actionable.
 */
export const MAX_CHECKPOINT_BYTES = 262_144;

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
  context: string
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
  if (bytes > MAX_SERIALIZED_BYTES) {
    throw new TaskSerializationError(
      context,
      `serialized size ${bytes} bytes exceeds the ${MAX_SERIALIZED_BYTES}-byte limit`
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
 * Name one value's type the way an error message should read it: the
 * constructor for an object, `typeof` for everything else.
 */
function describeType(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  const name: unknown = (value as { constructor?: { name?: unknown } })
    .constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "object";
}

/** Append one key to a dotted/bracketed key path. */
function keyPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

/** How a refusal names the offending member, with `""` for the root. */
function refusal(path: string, detail: string): string {
  return path === "" ? `value ${detail}` : `value at "${path}" ${detail}`;
}

/**
 * Walk one checkpoint and refuse the first member JSON cannot carry,
 * naming its key path.
 *
 * `JSON.stringify` is silent about exactly the mistakes that matter here: a
 * function member is dropped, a `Date` becomes a string, a `ReadableStream`
 * becomes `{}`. A state holding a live handle would persist as a
 * plausible-looking object and come back as something else a turn later, so
 * the commit refuses it instead. This is the runtime half of `AssertJson`
 * (§2.8), which the type layer applies only where a definition opts in, and
 * it accepts exactly what that type accepts: primitives, `undefined`
 * members (JSON drops them, as the type allows), arrays, and objects whose
 * prototype is `Object.prototype` or null.
 *
 * `seen` is the ancestor chain, not every visited value: a value repeated
 * across siblings is fine — JSON writes it twice — and only a cycle is
 * unrepresentable.
 */
function assertJsonStructure(
  value: unknown,
  context: string,
  path: string,
  seen: Set<object>
): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
    case "undefined":
      return;
    case "object":
      break;
    default:
      throw new TaskSerializationError(
        context,
        refusal(path, `of type ${typeof value} has no JSON representation`)
      );
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new TaskSerializationError(
      context,
      refusal(path, "is a circular reference and has no JSON representation")
    );
  }
  seen.add(object);
  if (Array.isArray(object)) {
    object.forEach((element, index) => {
      assertJsonStructure(element, context, keyPath(path, index), seen);
    });
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TaskSerializationError(
        context,
        refusal(
          path,
          `of type ${describeType(object)} has no JSON representation`
        )
      );
    }
    // Own enumerable string keys only: that is precisely what JSON writes,
    // so nothing else can be silently lost.
    for (const [key, member] of Object.entries(object)) {
      assertJsonStructure(member, context, keyPath(path, key), seen);
    }
  }
  seen.delete(object);
}

/**
 * Serialize one checkpoint for the run row.
 *
 * Runs BEFORE the fenced UPDATE that commits it, so a refusal leaves the
 * previous checkpoint intact.
 *
 * The compiled function definition's singleton is mapped to SQL `NULL`
 * here rather than at the call site: that is what keeps an upgraded run's
 * `checkpoint` column byte-identical to the NULL the v2 rows already
 * carry, and so what pins a function definition's turn at 0.
 *
 * @param checkpoint - The state a transition returned.
 * @param context - What is being serialized, for error messages.
 * @returns JSON text, or `null` for the compiled function definition's
 * singleton checkpoint and for no checkpoint at all.
 * @throws TaskCheckpointTooLargeError when the checkpoint exceeds
 * {@link MAX_CHECKPOINT_BYTES}, and {@link TaskSerializationError}, naming
 * the offending key path, when a member has no JSON representation.
 */
export function serializeTaskCheckpoint(
  checkpoint: unknown,
  context: string
): string | null {
  if (checkpoint === undefined || checkpoint === null) return null;
  if (isCompiledCheckpoint(checkpoint)) return null;

  // Structure first: `JSON.stringify` silently drops what it cannot carry,
  // so a refusal has to come from the walk rather than from its output.
  assertJsonStructure(checkpoint, context, "", new Set());

  let json: string;
  try {
    json = JSON.stringify(checkpoint);
  } catch (error) {
    throw new TaskSerializationError(
      context,
      error instanceof Error ? error.message : String(error)
    );
  }

  const bytes = utf8.encode(json).byteLength;
  if (bytes > MAX_CHECKPOINT_BYTES) {
    throw new TaskCheckpointTooLargeError(context, bytes, MAX_CHECKPOINT_BYTES);
  }
  return json;
}
