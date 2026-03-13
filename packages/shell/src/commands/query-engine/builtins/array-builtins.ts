/**
 * Array-related jq builtins
 *
 * Handles array manipulation functions like sort, sort_by, group_by, max, min, add, etc.
 */

import { mergeToNullPrototype } from "../../../helpers/env";
import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import { isSafeKey, safeHasOwn, safeSet } from "../safe-object";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

type EvalWithPartialFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

type CompareFn = (a: QueryValue, b: QueryValue) => number;
type IsTruthyFn = (v: QueryValue) => boolean;
type ContainsDeepFn = (a: QueryValue, b: QueryValue) => boolean;
type ExecutionLimitErrorClass = new (
  message: string,
  kind: "recursion" | "commands" | "iterations"
) => Error;

/**
 * Handle array builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not an array builtin handled here.
 */
export function evalArrayBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  evaluateWithPartialResults: EvalWithPartialFn,
  compareJq: CompareFn,
  isTruthy: IsTruthyFn,
  containsDeep: ContainsDeepFn,
  ExecutionLimitError: ExecutionLimitErrorClass
): QueryValue[] | null {
  switch (name) {
    case "sort":
      if (Array.isArray(value)) return [[...value].sort(compareJq)];
      return [null];

    case "sort_by": {
      if (!Array.isArray(value) || args.length === 0) return [null];
      const sorted = [...value].sort((a, b) => {
        const aKey = evaluate(a, args[0], ctx)[0];
        const bKey = evaluate(b, args[0], ctx)[0];
        return compareJq(aKey, bKey);
      });
      return [sorted];
    }

    case "bsearch": {
      if (!Array.isArray(value)) {
        const typeName =
          value === null
            ? "null"
            : typeof value === "object"
              ? "object"
              : typeof value;
        throw new Error(
          `${typeName} (${JSON.stringify(value)}) cannot be searched from`
        );
      }
      if (args.length === 0) return [null];
      const targets = evaluate(value, args[0], ctx);
      // Handle generator args - each target produces its own search result
      return targets.map((target) => {
        // Binary search: return index if found, or -insertionPoint-1 if not
        let lo = 0;
        let hi = value.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          const cmp = compareJq(value[mid], target);
          if (cmp < 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        // Check if we found an exact match
        if (lo < value.length && compareJq(value[lo], target) === 0) {
          return lo;
        }
        // Not found: return negative insertion point
        return -lo - 1;
      });
    }

    case "unique_by": {
      if (!Array.isArray(value) || args.length === 0) return [null];
      const seen = new Map<string, { item: QueryValue; key: QueryValue }>();
      for (const item of value) {
        const keyVal = evaluate(item, args[0], ctx)[0];
        const keyStr = JSON.stringify(keyVal);
        if (!seen.has(keyStr)) {
          seen.set(keyStr, { item, key: keyVal });
        }
      }
      // Sort by key value and return items
      const entries = [...seen.values()];
      entries.sort((a, b) => compareJq(a.key, b.key));
      return [entries.map((e) => e.item)];
    }

    case "group_by": {
      if (!Array.isArray(value) || args.length === 0) return [null];
      const groups = new Map<string, QueryValue[]>();
      for (const item of value) {
        const key = JSON.stringify(evaluate(item, args[0], ctx)[0]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(item);
      }
      return [[...groups.values()]];
    }

    case "max":
      if (Array.isArray(value) && value.length > 0) {
        return [value.reduce((a, b) => (compareJq(a, b) > 0 ? a : b))];
      }
      return [null];

    case "max_by": {
      if (!Array.isArray(value) || value.length === 0 || args.length === 0)
        return [null];
      return [
        value.reduce((a, b) => {
          const aKey = evaluate(a, args[0], ctx)[0];
          const bKey = evaluate(b, args[0], ctx)[0];
          return compareJq(aKey, bKey) > 0 ? a : b;
        })
      ];
    }

    case "min":
      if (Array.isArray(value) && value.length > 0) {
        return [value.reduce((a, b) => (compareJq(a, b) < 0 ? a : b))];
      }
      return [null];

    case "min_by": {
      if (!Array.isArray(value) || value.length === 0 || args.length === 0)
        return [null];
      return [
        value.reduce((a, b) => {
          const aKey = evaluate(a, args[0], ctx)[0];
          const bKey = evaluate(b, args[0], ctx)[0];
          return compareJq(aKey, bKey) < 0 ? a : b;
        })
      ];
    }

    case "add": {
      // Helper to add an array of values
      const addValues = (arr: QueryValue[]): QueryValue => {
        // jq filters out null values for add
        const filtered = arr.filter((x) => x !== null);
        if (filtered.length === 0) return null;
        if (filtered.every((x) => typeof x === "number")) {
          return filtered.reduce((a, b) => (a as number) + (b as number), 0);
        }
        if (filtered.every((x) => typeof x === "string")) {
          return filtered.join("");
        }
        if (filtered.every((x) => Array.isArray(x))) {
          return filtered.flat();
        }
        if (
          filtered.every((x) => x && typeof x === "object" && !Array.isArray(x))
        ) {
          // Use null-prototype to prevent prototype pollution from user-controlled JSON
          return mergeToNullPrototype(...(filtered as object[]));
        }
        return null;
      };

      // Handle add(expr) - collect values from generator and add them
      if (args.length >= 1) {
        const collected = evaluate(value, args[0], ctx);
        return [addValues(collected)];
      }
      // Existing behavior for add (no args) - add array elements
      if (Array.isArray(value)) {
        return [addValues(value)];
      }
      return [null];
    }

    case "any": {
      if (args.length >= 2) {
        // any(generator; condition) - lazy evaluation with short-circuit
        // Evaluate generator lazily, return true if any passes condition
        try {
          const genValues = evaluateWithPartialResults(value, args[0], ctx);
          for (const v of genValues) {
            const cond = evaluate(v, args[1], ctx);
            if (cond.some(isTruthy)) return [true];
          }
        } catch (e) {
          // Always re-throw execution limit errors
          if (e instanceof ExecutionLimitError) throw e;
          // Error occurred but we might have found a truthy value already
        }
        return [false];
      }
      if (args.length === 1) {
        if (Array.isArray(value)) {
          return [
            value.some((item) => isTruthy(evaluate(item, args[0], ctx)[0]))
          ];
        }
        return [false];
      }
      if (Array.isArray(value)) return [value.some(isTruthy)];
      return [false];
    }

    case "all": {
      if (args.length >= 2) {
        // all(generator; condition) - lazy evaluation with short-circuit
        // Evaluate generator lazily, return false if any fails condition
        try {
          const genValues = evaluateWithPartialResults(value, args[0], ctx);
          for (const v of genValues) {
            const cond = evaluate(v, args[1], ctx);
            if (!cond.some(isTruthy)) return [false];
          }
        } catch (e) {
          // Always re-throw execution limit errors
          if (e instanceof ExecutionLimitError) throw e;
          // Error occurred but we might have found a falsy value already
        }
        return [true];
      }
      if (args.length === 1) {
        if (Array.isArray(value)) {
          return [
            value.every((item) => isTruthy(evaluate(item, args[0], ctx)[0]))
          ];
        }
        return [true];
      }
      if (Array.isArray(value)) return [value.every(isTruthy)];
      return [true];
    }

    case "select": {
      if (args.length === 0) return [value];
      const conds = evaluate(value, args[0], ctx);
      return conds.some(isTruthy) ? [value] : [];
    }

    case "map": {
      if (args.length === 0 || !Array.isArray(value)) return [null];
      const results = value.flatMap((item) => evaluate(item, args[0], ctx));
      return [results];
    }

    case "map_values": {
      if (args.length === 0) return [null];
      if (Array.isArray(value)) {
        return [value.flatMap((item) => evaluate(item, args[0], ctx))];
      }
      if (value && typeof value === "object") {
        // Use null-prototype for additional safety
        const result: Record<string, unknown> = Object.create(null);
        for (const [k, v] of Object.entries(value)) {
          // Defense against prototype pollution
          if (!isSafeKey(k)) continue;
          const mapped = evaluate(v, args[0], ctx);
          if (mapped.length > 0) safeSet(result, k, mapped[0]);
        }
        return [result];
      }
      return [null];
    }

    case "has": {
      if (args.length === 0) return [false];
      const keys = evaluate(value, args[0], ctx);
      const key = keys[0];
      if (Array.isArray(value) && typeof key === "number") {
        return [key >= 0 && key < value.length];
      }
      if (value && typeof value === "object" && typeof key === "string") {
        // Use safeHasOwn to check own properties only (not inherited like __proto__)
        return [safeHasOwn(value, key)];
      }
      return [false];
    }

    case "in": {
      if (args.length === 0) return [false];
      const objs = evaluate(value, args[0], ctx);
      const obj = objs[0];
      if (Array.isArray(obj) && typeof value === "number") {
        return [value >= 0 && value < obj.length];
      }
      if (obj && typeof obj === "object" && typeof value === "string") {
        // Use safeHasOwn to check own properties only (not inherited like __proto__)
        return [safeHasOwn(obj, value)];
      }
      return [false];
    }

    case "contains": {
      if (args.length === 0) return [false];
      const others = evaluate(value, args[0], ctx);
      return [containsDeep(value, others[0])];
    }

    case "inside": {
      if (args.length === 0) return [false];
      const others = evaluate(value, args[0], ctx);
      return [containsDeep(others[0], value)];
    }

    default:
      return null;
  }
}
