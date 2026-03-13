/**
 * Control flow jq builtins
 *
 * Handles first, last, nth, range, limit, isempty, isvalid, skip, until, while, repeat.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
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

type IsTruthyFn = (v: QueryValue) => boolean;
type ExecutionLimitErrorClass = new (
  message: string,
  kind: "recursion" | "commands" | "iterations"
) => Error;

/**
 * Handle control flow builtins.
 * Returns null if the builtin name is not a control builtin handled here.
 */
export function evalControlBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
  evaluateWithPartialResults: EvalWithPartialFn,
  isTruthy: IsTruthyFn,
  ExecutionLimitError: ExecutionLimitErrorClass
): QueryValue[] | null {
  switch (name) {
    case "first":
      if (args.length > 0) {
        // Use lazy evaluation - get first value without evaluating rest
        try {
          const results = evaluateWithPartialResults(value, args[0], ctx);
          return results.length > 0 ? [results[0]] : [];
        } catch (e) {
          // Always re-throw execution limit errors
          if (e instanceof ExecutionLimitError) throw e;
          return [];
        }
      }
      if (Array.isArray(value) && value.length > 0) return [value[0]];
      return [null];

    case "last":
      if (args.length > 0) {
        const results = evaluate(value, args[0], ctx);
        return results.length > 0 ? [results[results.length - 1]] : [];
      }
      if (Array.isArray(value) && value.length > 0)
        return [value[value.length - 1]];
      return [null];

    case "nth": {
      if (args.length < 1) return [null];
      const ns = evaluate(value, args[0], ctx);
      // Handle generator args - each n produces its own output
      if (args.length > 1) {
        // Check for negative indices first
        for (const nv of ns) {
          const n = nv as number;
          if (n < 0) {
            throw new Error("nth doesn't support negative indices");
          }
        }
        // Use lazy evaluation to get partial results before errors
        let results: QueryValue[];
        try {
          results = evaluateWithPartialResults(value, args[1], ctx);
        } catch (e) {
          // Always re-throw execution limit errors
          if (e instanceof ExecutionLimitError) throw e;
          results = [];
        }
        return ns.flatMap((nv) => {
          const n = nv as number;
          return n < results.length ? [results[n]] : [];
        });
      }
      if (Array.isArray(value)) {
        return ns.flatMap((nv) => {
          const n = nv as number;
          if (n < 0) {
            throw new Error("nth doesn't support negative indices");
          }
          return n < value.length ? [value[n]] : [null];
        });
      }
      return [null];
    }

    case "range": {
      if (args.length === 0) return [];
      // range() is bounded by definition (terminates when reaching end),
      // so we use a higher limit than while/until/repeat loops.  Prevents
      // memory exhaustion from range(1e15) while allowing legitimate use
      // cases like date arithmetic (range(365*67) = 24455 elements).
      const maxRange = Math.max(ctx.limits.maxIterations * 100, 1_000_000);
      const rangeExceeded = (result: number[]) => result.length >= maxRange;
      const startsVals = evaluate(value, args[0], ctx);
      if (args.length === 1) {
        // range(n) - single arg, range from 0 to n
        // Handle generator args - each value produces its own range
        const result: number[] = [];
        for (const n of startsVals) {
          const num = n as number;
          for (let i = 0; i < num; i++) {
            result.push(i);
            if (rangeExceeded(result)) return result;
          }
        }
        return result;
      }
      const endsVals = evaluate(value, args[1], ctx);
      if (args.length === 2) {
        // range(start;end) - two args, range from start to end, step=1
        // But jq allows generators, so we need to handle multiple values
        const result: number[] = [];
        for (const s of startsVals) {
          for (const e of endsVals) {
            const start = s as number;
            const end = e as number;
            for (let i = start; i < end; i++) {
              result.push(i);
              if (rangeExceeded(result)) return result;
            }
          }
        }
        return result;
      }
      // range(start;end;step) - three args with step
      const stepsVals = evaluate(value, args[2], ctx);
      const result: number[] = [];
      for (const s of startsVals) {
        for (const e of endsVals) {
          for (const st of stepsVals) {
            const start = s as number;
            const end = e as number;
            const step = st as number;
            if (step === 0) continue; // Avoid infinite loop
            if (step > 0) {
              for (let i = start; i < end; i += step) {
                result.push(i);
                if (rangeExceeded(result)) return result;
              }
            } else {
              for (let i = start; i > end; i += step) {
                result.push(i);
                if (rangeExceeded(result)) return result;
              }
            }
          }
        }
      }
      return result;
    }

    case "limit": {
      if (args.length < 2) return [];
      const ns = evaluate(value, args[0], ctx);
      // Handle generator args - each n produces its own limited output
      return ns.flatMap((nv) => {
        const n = nv as number;
        // jq: negative limit throws error
        if (n < 0) {
          throw new Error("limit doesn't support negative count");
        }
        // jq: limit(0; expr) should return [] without evaluating expr
        if (n === 0) return [];
        // Use lazy evaluation to get partial results before errors
        let results: QueryValue[];
        try {
          results = evaluateWithPartialResults(value, args[1], ctx);
        } catch (e) {
          // Always re-throw execution limit errors
          if (e instanceof ExecutionLimitError) throw e;
          results = [];
        }
        return results.slice(0, n);
      });
    }

    case "isempty": {
      if (args.length < 1) return [true];
      // isempty returns true if the expression produces no values
      // It should short-circuit: if first value is produced, return false
      // For comma expressions like `1,error("foo")`, the left side produces a value
      // before the right side errors, so we should return false
      try {
        const results = evaluateWithPartialResults(value, args[0], ctx);
        return [results.length === 0];
      } catch (e) {
        // Always re-throw execution limit errors
        if (e instanceof ExecutionLimitError) throw e;
        // If an error occurs without any results, return true
        return [true];
      }
    }

    case "isvalid": {
      if (args.length < 1) return [true];
      // isvalid returns true if the expression produces at least one value without error
      try {
        const results = evaluate(value, args[0], ctx);
        return [results.length > 0];
      } catch (e) {
        // Always re-throw execution limit errors
        if (e instanceof ExecutionLimitError) throw e;
        // Any other error means invalid
        return [false];
      }
    }

    case "skip": {
      if (args.length < 2) return [];
      const ns = evaluate(value, args[0], ctx);
      // Handle generator args - each n produces its own skip result
      return ns.flatMap((nv) => {
        const n = nv as number;
        if (n < 0) {
          throw new Error("skip doesn't support negative count");
        }
        const results = evaluate(value, args[1], ctx);
        return results.slice(n);
      });
    }

    case "until": {
      if (args.length < 2) return [value];
      let current = value;
      const maxIterations = ctx.limits.maxIterations;
      for (let i = 0; i < maxIterations; i++) {
        const conds = evaluate(current, args[0], ctx);
        if (conds.some(isTruthy)) return [current];
        const next = evaluate(current, args[1], ctx);
        if (next.length === 0) return [current];
        current = next[0];
      }
      throw new ExecutionLimitError(
        `jq until: too many iterations (${maxIterations}), increase executionLimits.maxJqIterations`,
        "iterations"
      );
    }

    case "while": {
      if (args.length < 2) return [value];
      const results: QueryValue[] = [];
      let current = value;
      const maxIterations = ctx.limits.maxIterations;
      for (let i = 0; i < maxIterations; i++) {
        const conds = evaluate(current, args[0], ctx);
        if (!conds.some(isTruthy)) break;
        results.push(current);
        const next = evaluate(current, args[1], ctx);
        if (next.length === 0) break;
        current = next[0];
      }
      if (results.length >= maxIterations) {
        throw new ExecutionLimitError(
          `jq while: too many iterations (${maxIterations}), increase executionLimits.maxJqIterations`,
          "iterations"
        );
      }
      return results;
    }

    case "repeat": {
      if (args.length === 0) return [value];
      const results: QueryValue[] = [];
      let current = value;
      const maxIterations = ctx.limits.maxIterations;
      for (let i = 0; i < maxIterations; i++) {
        results.push(current);
        const next = evaluate(current, args[0], ctx);
        if (next.length === 0) break;
        current = next[0];
      }
      if (results.length >= maxIterations) {
        throw new ExecutionLimitError(
          `jq repeat: too many iterations (${maxIterations}), increase executionLimits.maxJqIterations`,
          "iterations"
        );
      }
      return results;
    }

    default:
      return null;
  }
}
