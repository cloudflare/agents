/**
 * Index-related jq builtins
 *
 * Handles index, rindex, and indices functions for finding positions in arrays/strings.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

type DeepEqualFn = (a: QueryValue, b: QueryValue) => boolean;

/**
 * Handle index builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an index builtin handled here.
 */
export function evalIndexBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  deepEqual: DeepEqualFn
): QueryValue[] | null {
  switch (name) {
    case "index": {
      if (args.length === 0) return [null];
      const needles = evaluate(value, args[0], ctx);
      // Handle generator args - each needle produces its own output
      return needles.map((needle) => {
        if (typeof value === "string" && typeof needle === "string") {
          // jq: index("") on "" returns null, not 0
          if (needle === "" && value === "") return null;
          const idx = value.indexOf(needle);
          return idx >= 0 ? idx : null;
        }
        if (Array.isArray(value)) {
          // If needle is an array, search for it as a subsequence
          if (Array.isArray(needle)) {
            for (let i = 0; i <= value.length - needle.length; i++) {
              let match = true;
              for (let j = 0; j < needle.length; j++) {
                if (!deepEqual(value[i + j], needle[j])) {
                  match = false;
                  break;
                }
              }
              if (match) return i;
            }
            return null;
          }
          // Otherwise search for the element
          const idx = value.findIndex((x) => deepEqual(x, needle));
          return idx >= 0 ? idx : null;
        }
        return null;
      });
    }

    case "rindex": {
      if (args.length === 0) return [null];
      const needles = evaluate(value, args[0], ctx);
      // Handle generator args - each needle produces its own output
      return needles.map((needle) => {
        if (typeof value === "string" && typeof needle === "string") {
          const idx = value.lastIndexOf(needle);
          return idx >= 0 ? idx : null;
        }
        if (Array.isArray(value)) {
          // If needle is an array, search for it as a subsequence from the end
          if (Array.isArray(needle)) {
            for (let i = value.length - needle.length; i >= 0; i--) {
              let match = true;
              for (let j = 0; j < needle.length; j++) {
                if (!deepEqual(value[i + j], needle[j])) {
                  match = false;
                  break;
                }
              }
              if (match) return i;
            }
            return null;
          }
          // Otherwise search for the element
          for (let i = value.length - 1; i >= 0; i--) {
            if (deepEqual(value[i], needle)) return i;
          }
          return null;
        }
        return null;
      });
    }

    case "indices": {
      if (args.length === 0) return [[]];
      const needles = evaluate(value, args[0], ctx);
      // Handle generator args - each needle produces its own result array
      return needles.map((needle) => {
        const result: number[] = [];
        if (typeof value === "string" && typeof needle === "string") {
          let idx = value.indexOf(needle);
          while (idx !== -1) {
            result.push(idx);
            idx = value.indexOf(needle, idx + 1);
          }
        } else if (Array.isArray(value)) {
          if (Array.isArray(needle)) {
            // Search for consecutive subarray matches
            const needleLen = needle.length;
            if (needleLen === 0) {
              // Empty array matches at every position
              for (let i = 0; i <= value.length; i++) result.push(i);
            } else {
              for (let i = 0; i <= value.length - needleLen; i++) {
                let match = true;
                for (let j = 0; j < needleLen; j++) {
                  if (!deepEqual(value[i + j], needle[j])) {
                    match = false;
                    break;
                  }
                }
                if (match) result.push(i);
              }
            }
          } else {
            // Search for individual element
            for (let i = 0; i < value.length; i++) {
              if (deepEqual(value[i], needle)) result.push(i);
            }
          }
        }
        return result;
      });
    }

    default:
      return null;
  }
}
