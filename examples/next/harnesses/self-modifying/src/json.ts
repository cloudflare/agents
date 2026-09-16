/** JSON data that can cross a Dynamic Worker RPC boundary. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object that can cross a Dynamic Worker RPC boundary. */
export type JsonObject = { [key: string]: JsonValue };

/** Return a JSON-safe clone of an unknown value. */
export function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  // SAFETY: JSON.stringify accepted the input and JSON.parse can only return
  // values in the JsonValue union.
  return JSON.parse(encoded) as JsonValue;
}
