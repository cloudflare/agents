/**
 * Path-related jq builtins
 *
 * Handles path manipulation functions like getpath, setpath, delpaths, paths, etc.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import { asQueryRecord } from "../safe-object";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

type IsTruthyFn = (v: QueryValue) => boolean;
type SetPathFn = (
  obj: QueryValue,
  path: (string | number)[],
  val: QueryValue
) => QueryValue;
type DeletePathFn = (obj: QueryValue, path: (string | number)[]) => QueryValue;
type ApplyDelFn = (
  value: QueryValue,
  expr: AstNode,
  ctx: EvalContext
) => QueryValue;
type CollectPathsFn = (
  value: QueryValue,
  expr: AstNode,
  ctx: EvalContext,
  currentPath: (string | number)[],
  paths: (string | number)[][]
) => void;

/**
 * Handle path builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a path builtin handled here.
 */
export function evalPathBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  isTruthy: IsTruthyFn,
  setPath: SetPathFn,
  deletePath: DeletePathFn,
  applyDel: ApplyDelFn,
  collectPaths: CollectPathsFn
): QueryValue[] | null {
  switch (name) {
    case "getpath": {
      if (args.length === 0) return [null];
      const paths = evaluate(value, args[0], ctx);
      // Handle multiple paths (generator argument)
      const results: QueryValue[] = [];
      for (const pathVal of paths) {
        const path = pathVal as (string | number)[];
        let current: QueryValue = value;
        for (const key of path) {
          if (current === null || current === undefined) {
            current = null;
            break;
          }
          if (Array.isArray(current) && typeof key === "number") {
            current = current[key];
          } else if (typeof key === "string") {
            // Defense against prototype pollution: only access own properties
            const obj = asQueryRecord(current);
            if (!obj || !Object.hasOwn(obj, key)) {
              current = null;
              break;
            }
            current = obj[key];
          } else {
            current = null;
            break;
          }
        }
        results.push(current);
      }
      return results;
    }

    case "setpath": {
      if (args.length < 2) return [null];
      const paths = evaluate(value, args[0], ctx);
      const path = paths[0] as (string | number)[];
      const vals = evaluate(value, args[1], ctx);
      const newVal = vals[0];
      return [setPath(value, path, newVal)];
    }

    case "delpaths": {
      if (args.length === 0) return [value];
      const pathLists = evaluate(value, args[0], ctx);
      const paths = pathLists[0] as (string | number)[][];
      let result = value;
      for (const path of paths.sort((a, b) => b.length - a.length)) {
        result = deletePath(result, path);
      }
      return [result];
    }

    case "path": {
      if (args.length === 0) return [[]];
      const paths: (string | number)[][] = [];
      collectPaths(value, args[0], ctx, [], paths);
      return paths;
    }

    case "del": {
      if (args.length === 0) return [value];
      return [applyDel(value, args[0], ctx)];
    }

    case "pick": {
      if (args.length === 0) return [null];
      // pick uses path() to get paths, then builds an object with just those paths
      // Collect paths from each argument
      const allPaths: (string | number)[][] = [];
      for (const arg of args) {
        collectPaths(value, arg, ctx, [], allPaths);
      }
      // Build result object with only the picked paths
      let result: QueryValue = null;
      for (const path of allPaths) {
        // Check for negative indices which are not allowed
        for (const key of path) {
          if (typeof key === "number" && key < 0) {
            throw new Error("Out of bounds negative array index");
          }
        }
        // Get the value at this path from the input
        let current: QueryValue = value;
        for (const key of path) {
          if (current === null || current === undefined) break;
          if (Array.isArray(current) && typeof key === "number") {
            current = current[key];
          } else if (typeof key === "string") {
            // Defense against prototype pollution: only access own properties
            const obj = asQueryRecord(current);
            if (!obj || !Object.hasOwn(obj, key)) {
              current = null;
              break;
            }
            current = obj[key];
          } else {
            current = null;
            break;
          }
        }
        // Set the value in the result
        result = setPath(result, path, current);
      }
      return [result];
    }

    case "paths": {
      const paths: (string | number)[][] = [];
      const walk = (v: QueryValue, path: (string | number)[]) => {
        if (v && typeof v === "object") {
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              paths.push([...path, i]);
              walk(v[i], [...path, i]);
            }
          } else {
            for (const key of Object.keys(v)) {
              paths.push([...path, key]);
              // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
              walk((v as Record<string, unknown>)[key], [...path, key]);
            }
          }
        }
      };
      walk(value, []);
      if (args.length > 0) {
        return paths.filter((p) => {
          let v: QueryValue = value;
          for (const k of p) {
            if (Array.isArray(v) && typeof k === "number") {
              v = v[k];
            } else if (typeof k === "string") {
              // Defense against prototype pollution: only access own properties
              const obj = asQueryRecord(v);
              if (!obj || !Object.hasOwn(obj, k)) {
                return false;
              }
              v = obj[k];
            } else {
              return false;
            }
          }
          const results = evaluate(v, args[0], ctx);
          return results.some(isTruthy);
        });
      }
      return paths;
    }

    case "leaf_paths": {
      const paths: (string | number)[][] = [];
      const walk = (v: QueryValue, path: (string | number)[]) => {
        if (v === null || typeof v !== "object") {
          paths.push(path);
        } else if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            walk(v[i], [...path, i]);
          }
        } else {
          // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
          for (const key of Object.keys(v)) {
            walk((v as Record<string, unknown>)[key], [...path, key]);
          }
        }
      };
      walk(value, []);
      // Return each path as a separate output (like paths does)
      return paths;
    }

    default:
      return null;
  }
}
