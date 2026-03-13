/**
 * SQL-like jq builtins
 *
 * Handles IN, INDEX, and JOIN functions.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import { asQueryRecord, isSafeKey, safeHasOwn, safeSet } from "../safe-object";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

type DeepEqualFn = (a: QueryValue, b: QueryValue) => boolean;

/**
 * Handle SQL-like builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a SQL builtin handled here.
 */
export function evalSqlBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  deepEqual: DeepEqualFn
): QueryValue[] | null {
  switch (name) {
    case "IN": {
      // IN(stream) - check if input is in stream
      // IN(stream1; stream2) - check if any value from stream1 is in stream2
      if (args.length === 0) return [false];
      if (args.length === 1) {
        // x | IN(stream) - check if x is in any value from stream
        const streamVals = evaluate(value, args[0], ctx);
        for (const v of streamVals) {
          if (deepEqual(value, v)) return [true];
        }
        return [false];
      }
      // IN(stream1; stream2) - check if any value from stream1 is in stream2
      const stream1Vals = evaluate(value, args[0], ctx);
      const stream2Vals = evaluate(value, args[1], ctx);
      const stream2Set = new Set(stream2Vals.map((v) => JSON.stringify(v)));
      for (const v of stream1Vals) {
        if (stream2Set.has(JSON.stringify(v))) return [true];
      }
      return [false];
    }

    case "INDEX": {
      // INDEX(stream) - create object mapping values to themselves
      // INDEX(stream; idx_expr) - create object using idx_expr as key
      // INDEX(stream; idx_expr; val_expr) - create object with idx_expr keys and val_expr values
      if (args.length === 0) return [Object.create(null)];
      if (args.length === 1) {
        // INDEX(stream) - index by the values themselves (like group_by)
        const streamVals = evaluate(value, args[0], ctx);
        const result: Record<string, unknown> = Object.create(null);
        for (const v of streamVals) {
          const key = String(v);
          // Defense against prototype pollution
          if (isSafeKey(key)) {
            safeSet(result, key, v);
          }
        }
        return [result];
      }
      if (args.length === 2) {
        // INDEX(stream; idx_expr) - index by idx_expr applied to each value
        const streamVals = evaluate(value, args[0], ctx);
        const result: Record<string, unknown> = Object.create(null);
        for (const v of streamVals) {
          const keys = evaluate(v, args[1], ctx);
          if (keys.length > 0) {
            const key = String(keys[0]);
            // Defense against prototype pollution
            if (isSafeKey(key)) {
              safeSet(result, key, v);
            }
          }
        }
        return [result];
      }
      // INDEX(stream; idx_expr; val_expr)
      const streamVals = evaluate(value, args[0], ctx);
      const result: Record<string, unknown> = Object.create(null);
      for (const v of streamVals) {
        const keys = evaluate(v, args[1], ctx);
        const vals = evaluate(v, args[2], ctx);
        if (keys.length > 0 && vals.length > 0) {
          const key = String(keys[0]);
          // Defense against prototype pollution
          if (isSafeKey(key)) {
            safeSet(result, key, vals[0]);
          }
        }
      }
      return [result];
    }

    case "JOIN": {
      // JOIN(idx; key_expr) - SQL-like join
      // For each item in input array, lookup in idx using key_expr, return [item, lookup_value]
      // If not found, returns [item, null]
      if (args.length < 2) return [null];
      const idxObj = asQueryRecord(evaluate(value, args[0], ctx)[0]);
      if (!idxObj) return [null];
      if (!Array.isArray(value)) return [null];
      const results: QueryValue[] = [];
      for (const item of value) {
        const keys = evaluate(item, args[1], ctx);
        const key = keys.length > 0 ? String(keys[0]) : "";
        const lookup = safeHasOwn(idxObj, key) ? idxObj[key] : null;
        results.push([item, lookup]);
      }
      return [results];
    }

    default:
      return null;
  }
}
