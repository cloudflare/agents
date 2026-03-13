/**
 * Object-related jq builtins
 *
 * Handles object manipulation functions like keys, to_entries, from_entries, etc.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import {
  asQueryRecord,
  isSafeKey,
  safeSet,
  sanitizeParsedData
} from "../safe-object";
import { getValueDepth, type QueryValue } from "../value-operations";

// Default max depth for nested structures
const DEFAULT_MAX_JQ_DEPTH = 2000;

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

/**
 * Handle object builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an object builtin handled here.
 */
export function evalObjectBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn
): QueryValue[] | null {
  switch (name) {
    case "keys":
      if (Array.isArray(value)) return [value.map((_, i) => i)];
      if (value && typeof value === "object")
        return [Object.keys(value).sort()];
      return [null];

    case "keys_unsorted":
      if (Array.isArray(value)) return [value.map((_, i) => i)];
      if (value && typeof value === "object") return [Object.keys(value)];
      return [null];

    case "length":
      if (typeof value === "string") return [value.length];
      if (Array.isArray(value)) return [value.length];
      if (value && typeof value === "object")
        return [Object.keys(value).length];
      if (value === null) return [0];
      // jq: length of a number is its absolute value
      if (typeof value === "number") return [Math.abs(value)];
      return [null];

    case "utf8bytelength": {
      if (typeof value === "string")
        return [new TextEncoder().encode(value).length];
      // jq: throws error for non-strings with type info
      const typeName =
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const valueStr =
        typeName === "array" || typeName === "object"
          ? JSON.stringify(value)
          : String(value);
      throw new Error(
        `${typeName} (${valueStr}) only strings have UTF-8 byte length`
      );
    }

    case "to_entries": {
      const toEntriesObj = asQueryRecord(value);
      if (toEntriesObj) {
        return [
          Object.entries(toEntriesObj).map(([key, val]) => ({
            key,
            value: val
          }))
        ];
      }
      return [null];
    }

    case "from_entries":
      if (Array.isArray(value)) {
        const result: Record<string, unknown> = Object.create(null);
        for (const item of value) {
          const obj = asQueryRecord(item);
          if (obj) {
            // jq supports: key, Key, name, Name, k for the key
            const key = obj.key ?? obj.Key ?? obj.name ?? obj.Name ?? obj.k;
            // jq supports: value, Value, v for the value
            const val = obj.value ?? obj.Value ?? obj.v;
            if (key !== undefined) {
              const strKey = String(key);
              // Defense against prototype pollution: skip dangerous keys
              if (isSafeKey(strKey)) {
                safeSet(result, strKey, val);
              }
            }
          }
        }
        return [result];
      }
      return [null];

    case "with_entries": {
      if (args.length === 0) return [value];
      const withEntriesObj = asQueryRecord(value);
      if (withEntriesObj) {
        const entries = Object.entries(withEntriesObj).map(([key, val]) => ({
          key,
          value: val
        }));
        const mapped = entries.flatMap((e) => evaluate(e, args[0], ctx));
        const result: Record<string, unknown> = Object.create(null);
        for (const item of mapped) {
          const obj = asQueryRecord(item);
          if (obj) {
            const key = obj.key ?? obj.name ?? obj.k;
            const val = obj.value ?? obj.v;
            if (key !== undefined) {
              const strKey = String(key);
              // Defense against prototype pollution: skip dangerous keys
              if (isSafeKey(strKey)) {
                safeSet(result, strKey, val);
              }
            }
          }
        }
        return [result];
      }
      return [null];
    }

    case "reverse":
      if (Array.isArray(value)) return [[...value].reverse()];
      if (typeof value === "string")
        return [value.split("").reverse().join("")];
      return [null];

    case "flatten": {
      if (!Array.isArray(value)) return [null];
      const depths =
        args.length > 0
          ? evaluate(value, args[0], ctx)
          : [Number.POSITIVE_INFINITY];
      // Handle generator args - each depth produces its own output
      return depths.map((d) => {
        const depth = d as number;
        if (depth < 0) {
          throw new Error("flatten depth must not be negative");
        }
        return value.flat(depth);
      });
    }

    case "unique":
      if (Array.isArray(value)) {
        const seen = new Set<string>();
        const result: QueryValue[] = [];
        for (const item of value) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
          }
        }
        return [result];
      }
      return [null];

    case "tojson":
    case "tojsonstream": {
      // Check depth to avoid V8 stack overflow during JSON.stringify
      const maxDepth = ctx.limits.maxDepth ?? DEFAULT_MAX_JQ_DEPTH;
      if (getValueDepth(value, maxDepth + 1) > maxDepth) {
        return [null];
      }
      return [JSON.stringify(value)];
    }

    case "fromjson": {
      if (typeof value === "string") {
        // jq extension: "nan" and "inf"/"infinity" are valid
        const trimmed = value.trim().toLowerCase();
        if (trimmed === "nan") {
          return [Number.NaN];
        }
        if (trimmed === "inf" || trimmed === "infinity") {
          return [Number.POSITIVE_INFINITY];
        }
        if (trimmed === "-inf" || trimmed === "-infinity") {
          return [Number.NEGATIVE_INFINITY];
        }
        try {
          return [sanitizeParsedData(JSON.parse(value))];
        } catch {
          throw new Error(`Invalid JSON: ${value}`);
        }
      }
      return [value];
    }

    case "tostring":
      if (typeof value === "string") return [value];
      return [JSON.stringify(value)];

    case "tonumber":
      if (typeof value === "number") return [value];
      if (typeof value === "string") {
        const n = Number(value);
        if (Number.isNaN(n)) {
          throw new Error(
            `${JSON.stringify(value)} cannot be parsed as a number`
          );
        }
        return [n];
      }
      throw new Error(`${typeof value} cannot be parsed as a number`);

    case "toboolean": {
      // jq: toboolean converts "true"/"false" strings and booleans to booleans
      if (typeof value === "boolean") return [value];
      if (typeof value === "string") {
        if (value === "true") return [true];
        if (value === "false") return [false];
        throw new Error(
          `string (${JSON.stringify(value)}) cannot be parsed as a boolean`
        );
      }
      const typeName =
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const valueStr =
        typeName === "array" || typeName === "object"
          ? JSON.stringify(value)
          : String(value);
      throw new Error(
        `${typeName} (${valueStr}) cannot be parsed as a boolean`
      );
    }

    case "tostream": {
      // tostream outputs [path, leaf_value] pairs for each leaf, plus [[]] at end
      const results: QueryValue[] = [];
      const walk = (v: QueryValue, path: (string | number)[]) => {
        if (v === null || typeof v !== "object") {
          // Leaf value - output [path, value]
          results.push([path, v]);
        } else if (Array.isArray(v)) {
          if (v.length === 0) {
            // Empty array - output [path, []]
            results.push([path, []]);
          } else {
            for (let i = 0; i < v.length; i++) {
              walk(v[i], [...path, i]);
            }
          }
        } else {
          const keys = Object.keys(v);
          if (keys.length === 0) {
            // Empty object - output [path, {}]
            results.push([path, Object.create(null)]);
          } else {
            // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
            for (const key of keys) {
              walk((v as Record<string, unknown>)[key], [...path, key]);
            }
          }
        }
      };
      walk(value, []);
      // End marker: [[]] (empty path array wrapped in array)
      results.push([[]]);
      return results;
    }

    case "fromstream": {
      // fromstream(stream_expr) reconstructs values from stream of [path, value] pairs
      if (args.length === 0) return [value];
      const streamItems = evaluate(value, args[0], ctx);
      let result: QueryValue = null;

      for (const item of streamItems) {
        if (!Array.isArray(item)) continue;
        if (
          item.length === 1 &&
          Array.isArray(item[0]) &&
          item[0].length === 0
        ) {
          // End marker [[]] - skip
          continue;
        }
        if (item.length !== 2) continue;
        const [path, val] = item;
        if (!Array.isArray(path)) continue;

        // Set value at path, creating structure as needed
        if (path.length === 0) {
          result = val;
          continue;
        }

        // Auto-create root structure based on first path element
        if (result === null) {
          result = typeof path[0] === "number" ? [] : Object.create(null);
        }

        // Navigate to parent and set value
        let current: QueryValue = result;
        for (let i = 0; i < path.length - 1; i++) {
          const key = path[i];
          const nextKey = path[i + 1];
          if (Array.isArray(current) && typeof key === "number") {
            // Extend array if needed
            while (current.length <= key) {
              current.push(null);
            }
            if (current[key] === null) {
              current[key] =
                typeof nextKey === "number" ? [] : Object.create(null);
            }
            current = current[key];
          } else {
            const obj = asQueryRecord(current);
            if (obj) {
              const strKey = String(key);
              // Defense against prototype pollution: skip dangerous keys
              if (!isSafeKey(strKey)) continue;
              if (obj[strKey] === null || obj[strKey] === undefined) {
                safeSet(
                  obj,
                  strKey,
                  typeof nextKey === "number" ? [] : Object.create(null)
                );
              }
              current = obj[strKey] as QueryValue;
            }
          }
        }

        // Set the final value
        const lastKey = path[path.length - 1];
        if (Array.isArray(current) && typeof lastKey === "number") {
          while (current.length <= lastKey) {
            current.push(null);
          }
          current[lastKey] = val;
        } else {
          const lastObj = asQueryRecord(current);
          if (lastObj) {
            const strLastKey = String(lastKey);
            // Defense against prototype pollution: skip dangerous keys
            if (isSafeKey(strLastKey)) {
              safeSet(lastObj, strLastKey, val);
            }
          }
        }
      }

      return [result];
    }

    case "truncate_stream": {
      // truncate_stream(stream_items) truncates paths by removing first n elements
      // where n is the input value (depth)
      const depth = typeof value === "number" ? Math.floor(value) : 0;
      if (args.length === 0) return [];

      const results: QueryValue[] = [];
      const streamItems = evaluate(value, args[0], ctx);

      for (const item of streamItems) {
        if (!Array.isArray(item)) continue;

        // Handle end markers [[path]] (length 1, first element is array)
        if (item.length === 1 && Array.isArray(item[0])) {
          const path = item[0] as (string | number)[];
          if (path.length > depth) {
            // Truncate the path
            results.push([path.slice(depth)]);
          }
          // If path.length <= depth, skip (becomes root end marker)
          continue;
        }

        // Handle value items [[path], value] (length 2)
        if (item.length === 2 && Array.isArray(item[0])) {
          const path = item[0] as (string | number)[];
          const val = item[1];
          if (path.length > depth) {
            // Truncate the path
            results.push([path.slice(depth), val]);
          }
          // If path.length <= depth, skip
        }
      }

      return results;
    }

    default:
      return null;
  }
}
