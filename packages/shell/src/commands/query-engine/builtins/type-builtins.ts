/**
 * Type-related jq builtins
 *
 * Handles type checking and type filtering functions like type, numbers, strings, etc.
 */

import type { QueryValue } from "../value-operations";

/**
 * Handle type builtins.
 * Returns null if the builtin name is not a type builtin handled here.
 */
export function evalTypeBuiltin(
  value: QueryValue,
  name: string
): QueryValue[] | null {
  switch (name) {
    case "type":
      if (value === null) return ["null"];
      if (Array.isArray(value)) return ["array"];
      if (typeof value === "boolean") return ["boolean"];
      if (typeof value === "number") return ["number"];
      if (typeof value === "string") return ["string"];
      if (typeof value === "object") return ["object"];
      return ["null"];

    case "infinite":
      // jq: `infinite` produces positive infinity
      return [Number.POSITIVE_INFINITY];

    case "nan":
      // jq: `nan` produces NaN value
      return [Number.NaN];

    case "isinfinite":
      return [typeof value === "number" && !Number.isFinite(value)];

    case "isnan":
      return [typeof value === "number" && Number.isNaN(value)];

    case "isnormal":
      return [
        typeof value === "number" && Number.isFinite(value) && value !== 0
      ];

    case "isfinite":
      return [typeof value === "number" && Number.isFinite(value)];

    case "numbers":
      return typeof value === "number" ? [value] : [];

    case "strings":
      return typeof value === "string" ? [value] : [];

    case "booleans":
      return typeof value === "boolean" ? [value] : [];

    case "nulls":
      return value === null ? [value] : [];

    case "arrays":
      return Array.isArray(value) ? [value] : [];

    case "objects":
      return value && typeof value === "object" && !Array.isArray(value)
        ? [value]
        : [];

    case "iterables":
      return Array.isArray(value) ||
        (value && typeof value === "object" && !Array.isArray(value))
        ? [value]
        : [];

    case "scalars":
      return !Array.isArray(value) && !(value && typeof value === "object")
        ? [value]
        : [];

    case "values":
      // jq: values outputs input if not null, nothing otherwise
      if (value === null) return [];
      return [value];

    case "not":
      // jq: not returns the logical negation
      if (value === false || value === null) return [true];
      return [false];

    case "null":
      return [null];

    case "true":
      return [true];

    case "false":
      return [false];

    case "empty":
      return [];

    default:
      return null;
  }
}
