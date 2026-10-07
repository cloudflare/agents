import type { JsonValue } from "../protocol";

/** A JSON object. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Whether a JSON value is an object (not an array or a primitive).
 *
 * @param value - The value, or undefined for a missing field.
 * @returns True for an object.
 */
export function isJsonObject(
  value: JsonValue | undefined
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The strings of a JSON array field.
 *
 * @param value - The field.
 * @returns Its string elements, or undefined when it is not an array.
 */
export function stringsOf(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((each): each is string => typeof each === "string");
}
