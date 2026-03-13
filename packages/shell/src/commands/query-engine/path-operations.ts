/**
 * Query Path Utilities
 *
 * Utility functions for path-based operations on query values.
 */

import {
  asQueryRecord,
  isSafeKey,
  nullPrototypeCopy,
  safeSet
} from "./safe-object";
import type { QueryValue } from "./value-operations";

/**
 * Set a value at a given path within a query value.
 * Creates intermediate arrays/objects as needed.
 */
export function setPath(
  value: QueryValue,
  path: (string | number)[],
  newVal: QueryValue
): QueryValue {
  if (path.length === 0) return newVal;

  const [head, ...rest] = path;

  if (typeof head === "number") {
    // jq: Cannot index object with number
    if (value && typeof value === "object" && !Array.isArray(value)) {
      throw new Error("Cannot index object with number");
    }
    // jq: Array index too large (limit to prevent memory issues)
    const MAX_ARRAY_INDEX = 536870911; // jq's limit
    if (head > MAX_ARRAY_INDEX) {
      throw new Error("Array index too large");
    }
    // jq: Out of bounds negative array index
    if (head < 0) {
      throw new Error("Out of bounds negative array index");
    }
    const arr = Array.isArray(value) ? [...value] : [];
    while (arr.length <= head) arr.push(null);
    arr[head] = setPath(arr[head], rest, newVal);
    return arr;
  }

  // jq: Cannot index array with string (path key must be string for objects)
  if (Array.isArray(value)) {
    throw new Error("Cannot index array with string");
  }

  // Defense against prototype pollution: skip dangerous keys
  if (!isSafeKey(head)) {
    // Return the value unchanged - silently ignore dangerous keys
    return value ?? Object.create(null);
  }

  const rec = asQueryRecord(value);
  const obj: Record<string, unknown> = rec
    ? nullPrototypeCopy(rec)
    : Object.create(null);
  const currentVal = Object.hasOwn(obj, head) ? obj[head] : undefined;
  safeSet(obj, head, setPath(currentVal, rest, newVal));
  return obj;
}

/**
 * Delete a value at a given path within a query value.
 */
export function deletePath(
  value: QueryValue,
  path: (string | number)[]
): QueryValue {
  if (path.length === 0) return null;
  if (path.length === 1) {
    const key = path[0];
    if (Array.isArray(value) && typeof key === "number") {
      const arr = [...value];
      arr.splice(key, 1);
      return arr;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const strKey = String(key);
      // Defense against prototype pollution: skip dangerous keys
      if (!isSafeKey(strKey)) {
        return value;
      }
      const obj = nullPrototypeCopy(value);
      delete obj[strKey];
      return obj;
    }
    return value;
  }

  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    const arr = [...value];
    arr[head] = deletePath(arr[head], rest);
    return arr;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const strHead = String(head);
    // Defense against prototype pollution: skip dangerous keys
    if (!isSafeKey(strHead)) {
      return value;
    }
    const obj = nullPrototypeCopy(value);
    if (Object.hasOwn(obj, strHead)) {
      safeSet(obj, strHead, deletePath(obj[strHead], rest));
    }
    return obj;
  }
  return value;
}
