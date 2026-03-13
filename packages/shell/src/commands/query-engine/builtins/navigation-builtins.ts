/**
 * Navigation and traversal jq builtins
 *
 * Handles recurse, recurse_down, walk, transpose, combinations, parent, parents, root.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import { isSafeKey, safeSet } from "../safe-object";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

type IsTruthyFn = (v: QueryValue) => boolean;
type GetValueAtPathFn = (
  obj: QueryValue,
  path: (string | number)[]
) => QueryValue;

// Recursive forward reference for evalBuiltin
type EvalBuiltinFn = (
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext
) => QueryValue[];

/**
 * Handle navigation builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a navigation builtin handled here.
 */
export function evalNavigationBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  isTruthy: IsTruthyFn,
  getValueAtPath: GetValueAtPathFn,
  evalBuiltin: EvalBuiltinFn
): QueryValue[] | null {
  switch (name) {
    case "recurse": {
      if (args.length === 0) {
        const results: QueryValue[] = [];
        const walk = (v: QueryValue) => {
          results.push(v);
          if (Array.isArray(v)) {
            for (const item of v) walk(item);
          } else if (v && typeof v === "object") {
            // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
            for (const key of Object.keys(v)) {
              walk((v as Record<string, unknown>)[key]);
            }
          }
        };
        walk(value);
        return results;
      }
      const results: QueryValue[] = [];
      const condExpr = args.length >= 2 ? args[1] : null;
      const maxDepth = 10000; // Prevent infinite loops
      let depth = 0;
      const walk = (v: QueryValue) => {
        if (depth++ > maxDepth) return;
        // Check condition if provided (recurse(f; cond))
        if (condExpr) {
          const condResults = evaluate(v, condExpr, ctx);
          if (!condResults.some(isTruthy)) return;
        }
        results.push(v);
        const next = evaluate(v, args[0], ctx);
        for (const n of next) {
          if (n !== null && n !== undefined) walk(n);
        }
      };
      walk(value);
      return results;
    }

    case "recurse_down":
      return evalBuiltin(value, "recurse", args, ctx);

    case "walk": {
      if (args.length === 0) return [value];
      const seen = new WeakSet<object>();
      const walkFn = (v: QueryValue): QueryValue => {
        if (v && typeof v === "object") {
          if (seen.has(v as object)) return v;
          seen.add(v as object);
        }
        let transformed: QueryValue;
        if (Array.isArray(v)) {
          transformed = v.map(walkFn);
        } else if (v && typeof v === "object") {
          // Use null-prototype for additional safety
          const obj: Record<string, unknown> = Object.create(null);
          for (const [k, val] of Object.entries(v)) {
            // Defense against prototype pollution
            if (isSafeKey(k)) {
              safeSet(obj, k, walkFn(val));
            }
          }
          transformed = obj;
        } else {
          transformed = v;
        }
        const results = evaluate(transformed, args[0], ctx);
        return results[0];
      };
      return [walkFn(value)];
    }

    case "transpose": {
      if (!Array.isArray(value)) return [null];
      if (value.length === 0) return [[]];
      const maxLen = Math.max(
        ...value.map((row) => (Array.isArray(row) ? row.length : 0))
      );
      const result: QueryValue[][] = [];
      for (let i = 0; i < maxLen; i++) {
        result.push(value.map((row) => (Array.isArray(row) ? row[i] : null)));
      }
      return [result];
    }

    case "combinations": {
      // Generate Cartesian product of arrays
      // combinations with no args: input is array of arrays, generate all combinations
      // combinations(n): generate n-length combinations from input array
      if (args.length > 0) {
        // combinations(n) - n-tuples from input array
        const ns = evaluate(value, args[0], ctx);
        const n = ns[0] as number;
        if (!Array.isArray(value) || n < 0) return [];
        if (n === 0) return [[]];
        // Generate all n-length combinations with repetition
        const results: QueryValue[][] = [];
        const generate = (current: QueryValue[], depth: number) => {
          if (depth === n) {
            results.push([...current]);
            return;
          }
          for (const item of value) {
            current.push(item);
            generate(current, depth + 1);
            current.pop();
          }
        };
        generate([], 0);
        return results;
      }
      // combinations with no args - Cartesian product of array of arrays
      if (!Array.isArray(value)) return [];
      if (value.length === 0) return [[]];
      // Check all elements are arrays
      for (const arr of value) {
        if (!Array.isArray(arr)) return [];
      }
      // Generate Cartesian product
      const results: QueryValue[][] = [];
      const generate = (index: number, current: QueryValue[]) => {
        if (index === value.length) {
          results.push([...current]);
          return;
        }
        const arr = value[index] as QueryValue[];
        for (const item of arr) {
          current.push(item);
          generate(index + 1, current);
          current.pop();
        }
      };
      generate(0, []);
      return results;
    }

    // Navigation operators
    case "parent": {
      if (ctx.root === undefined || ctx.currentPath === undefined) return [];
      const path = ctx.currentPath;
      if (path.length === 0) return []; // At root, no parent

      // Get levels argument (default: 1)
      const levels =
        args.length > 0 ? (evaluate(value, args[0], ctx)[0] as number) : 1;

      if (levels >= 0) {
        // Positive: go up n levels
        if (levels > path.length) return []; // Beyond root
        const parentPath = path.slice(0, path.length - levels);
        return [getValueAtPath(ctx.root, parentPath)];
      } else {
        // Negative: index from root (-1 = root, -2 = one below root, etc.)
        // -1 means path length 0 (root)
        // -2 means path length 1 (one level below root)
        const targetLen = -levels - 1;
        if (targetLen >= path.length) return [value]; // Beyond current
        const parentPath = path.slice(0, targetLen);
        return [getValueAtPath(ctx.root, parentPath)];
      }
    }

    case "parents": {
      if (ctx.root === undefined || ctx.currentPath === undefined) return [[]];
      const path = ctx.currentPath;
      const parents: QueryValue[] = [];
      // Build array of parents from immediate parent to root
      for (let i = path.length - 1; i >= 0; i--) {
        parents.push(getValueAtPath(ctx.root, path.slice(0, i)));
      }
      return [parents];
    }

    case "root":
      return ctx.root !== undefined ? [ctx.root] : [];

    default:
      return null;
  }
}
