/**
 * Math-related jq builtins
 *
 * Handles mathematical functions like abs, pow, exp, trig functions, etc.
 */

import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

/**
 * Handle math builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a math builtin handled here.
 */
export function evalMathBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn
): QueryValue[] | null {
  switch (name) {
    case "fabs":
    case "abs":
      if (typeof value === "number") return [Math.abs(value)];
      // jq returns strings unchanged for abs
      if (typeof value === "string") return [value];
      return [null];

    case "exp10":
      if (typeof value === "number") return [10 ** value];
      return [null];

    case "exp2":
      if (typeof value === "number") return [2 ** value];
      return [null];

    case "pow": {
      // pow(base; exp) - two explicit arguments
      if (args.length < 2) return [null];
      const bases = evaluate(value, args[0], ctx);
      const exps = evaluate(value, args[1], ctx);
      const base = bases[0];
      const exp = exps[0];
      if (typeof base !== "number" || typeof exp !== "number") return [null];
      return [base ** exp];
    }

    case "atan2": {
      // atan2(y; x) - two explicit arguments
      if (args.length < 2) return [null];
      const ys = evaluate(value, args[0], ctx);
      const xs = evaluate(value, args[1], ctx);
      const y = ys[0];
      const x = xs[0];
      if (typeof y !== "number" || typeof x !== "number") return [null];
      return [Math.atan2(y, x)];
    }

    case "hypot": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      return [Math.hypot(value, y)];
    }

    case "fma": {
      if (typeof value !== "number" || args.length < 2) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      const z = evaluate(value, args[1], ctx)[0] as number;
      return [value * y + z];
    }

    case "copysign": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      return [Math.sign(y) * Math.abs(value)];
    }

    case "drem":
    case "remainder": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      return [value - Math.round(value / y) * y];
    }

    case "fdim": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      return [Math.max(0, value - y)];
    }

    case "fmax": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      return [Math.max(value, y)];
    }

    case "fmin": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const y = evaluate(value, args[0], ctx)[0] as number;
      return [Math.min(value, y)];
    }

    case "ldexp": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const exp = evaluate(value, args[0], ctx)[0] as number;
      return [value * 2 ** exp];
    }

    case "scalbn":
    case "scalbln": {
      if (typeof value !== "number" || args.length === 0) return [null];
      const exp = evaluate(value, args[0], ctx)[0] as number;
      return [value * 2 ** exp];
    }

    case "nearbyint":
      if (typeof value === "number") return [Math.round(value)];
      return [null];

    case "logb":
      if (typeof value === "number")
        return [Math.floor(Math.log2(Math.abs(value)))];
      return [null];

    case "significand":
      if (typeof value === "number") {
        const exp = Math.floor(Math.log2(Math.abs(value)));
        return [value / 2 ** exp];
      }
      return [null];

    case "frexp":
      if (typeof value === "number") {
        if (value === 0) return [[0, 0]];
        const exp = Math.floor(Math.log2(Math.abs(value))) + 1;
        const mantissa = value / 2 ** exp;
        return [[mantissa, exp]];
      }
      return [null];

    case "modf":
      if (typeof value === "number") {
        const intPart = Math.trunc(value);
        const fracPart = value - intPart;
        return [[fracPart, intPart]];
      }
      return [null];

    default:
      return null;
  }
}
