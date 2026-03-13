/**
 * Query expression evaluator
 *
 * Evaluates a parsed query AST against any value.
 * Used by jq, yq, and other query-based commands.
 */

import { mapToRecord } from "../../helpers/env";
import { ExecutionLimitError } from "../../interpreter/errors";
import {
  evalArrayBuiltin,
  evalControlBuiltin,
  evalDateBuiltin,
  evalFormatBuiltin,
  evalIndexBuiltin,
  evalMathBuiltin,
  evalNavigationBuiltin,
  evalObjectBuiltin,
  evalPathBuiltin,
  evalSqlBuiltin,
  evalStringBuiltin,
  evalTypeBuiltin
} from "./builtins/index";
import type { AstNode, DestructurePattern } from "./parser";
import { deletePath, setPath } from "./path-operations";
import {
  asQueryRecord,
  isSafeKey,
  nullPrototypeCopy,
  nullPrototypeMerge,
  safeHasOwn,
  safeSet
} from "./safe-object";
import {
  compare,
  compareJq,
  containsDeep,
  deepEqual,
  deepMerge,
  getValueDepth,
  isTruthy,
  type QueryValue
} from "./value-operations";

export type { QueryValue } from "./value-operations";

class BreakError extends Error {
  constructor(
    public readonly label: string,
    public readonly partialResults: QueryValue[] = []
  ) {
    super(`break ${label}`);
    this.name = "BreakError";
  }

  withPrependedResults(results: QueryValue[]): BreakError {
    return new BreakError(this.label, [...results, ...this.partialResults]);
  }
}

// Custom error that preserves the original jq value
class JqError extends Error {
  constructor(public readonly value: QueryValue) {
    super(typeof value === "string" ? value : JSON.stringify(value));
    this.name = "JqError";
  }
}

const DEFAULT_MAX_JQ_ITERATIONS = 10000;
// Depth limit for nested structures - must be low enough to avoid V8 stack overflow
// during JSON.stringify/parse which have their own recursion limits (~2000-10000 depending on V8 version)
const DEFAULT_MAX_JQ_DEPTH = 2000;

/**
 * Simple math functions that take a single numeric argument and return a single numeric result.
 * Maps jq function names to their JavaScript Math implementations.
 * Uses Map to avoid prototype pollution (e.g., if someone tries to call "constructor" as a function).
 */
const SIMPLE_MATH_FUNCTIONS = new Map<string, (x: number) => number>([
  ["floor", Math.floor],
  ["ceil", Math.ceil],
  ["round", Math.round],
  ["sqrt", Math.sqrt],
  ["log", Math.log],
  ["log10", Math.log10],
  ["log2", Math.log2],
  ["exp", Math.exp],
  ["sin", Math.sin],
  ["cos", Math.cos],
  ["tan", Math.tan],
  ["asin", Math.asin],
  ["acos", Math.acos],
  ["atan", Math.atan],
  ["sinh", Math.sinh],
  ["cosh", Math.cosh],
  ["tanh", Math.tanh],
  ["asinh", Math.asinh],
  ["acosh", Math.acosh],
  ["atanh", Math.atanh],
  ["cbrt", Math.cbrt],
  ["expm1", Math.expm1],
  ["log1p", Math.log1p],
  ["trunc", Math.trunc]
]);

export interface QueryExecutionLimits {
  maxIterations?: number;
  maxDepth?: number;
}

export interface EvalContext {
  vars: Map<string, QueryValue>;
  limits: Required<Pick<QueryExecutionLimits, "maxIterations">> &
    QueryExecutionLimits;
  env?: Map<string, string>;
  defenseContextChecked?: boolean;
  /** Original document root for parent/root navigation */
  root?: QueryValue;
  /** Current path from root for parent navigation */
  currentPath?: (string | number)[];
  funcs?: Map<
    string,
    { params: string[]; body: AstNode; closure?: Map<string, unknown> }
  >;
  labels?: Set<string>;
}

function createContext(options?: EvaluateOptions): EvalContext {
  return {
    vars: new Map(),
    limits: {
      maxIterations:
        options?.limits?.maxIterations ?? DEFAULT_MAX_JQ_ITERATIONS,
      maxDepth: options?.limits?.maxDepth ?? DEFAULT_MAX_JQ_DEPTH
    },
    env: options?.env,
    defenseContextChecked: false
  };
}

function withVar(
  ctx: EvalContext,
  name: string,
  value: QueryValue
): EvalContext {
  const newVars = new Map(ctx.vars);
  newVars.set(name, value);
  return {
    vars: newVars,
    limits: ctx.limits,
    env: ctx.env,
    defenseContextChecked: ctx.defenseContextChecked,
    root: ctx.root,
    currentPath: ctx.currentPath,
    funcs: ctx.funcs,
    labels: ctx.labels
  };
}

/**
 * Bind variables according to a destructuring pattern
 * Returns null if the pattern doesn't match the value
 */
function bindPattern(
  ctx: EvalContext,
  pattern: DestructurePattern,
  value: QueryValue
): EvalContext | null {
  switch (pattern.type) {
    case "var":
      return withVar(ctx, pattern.name, value);

    case "array": {
      if (!Array.isArray(value)) return null;
      let newCtx = ctx;
      for (let i = 0; i < pattern.elements.length; i++) {
        const elem = pattern.elements[i];
        const elemValue = i < value.length ? value[i] : null;
        const result = bindPattern(newCtx, elem, elemValue);
        if (result === null) return null;
        newCtx = result;
      }
      return newCtx;
    }

    case "object": {
      const obj = asQueryRecord(value);
      if (!obj) return null;
      let newCtx = ctx;
      for (const field of pattern.fields) {
        // Get the key - could be a string or a computed expression
        let key: string;
        if (typeof field.key === "string") {
          key = field.key;
        } else {
          // Computed key - evaluate it
          const keyVals = evaluate(value, field.key, ctx);
          if (keyVals.length === 0) return null;
          key = String(keyVals[0]);
        }
        const fieldValue = safeHasOwn(obj, key) ? obj[key] : null;
        // If keyVar is set (e.g., $b:[$c,$d]), also bind the key variable to the whole value
        if (field.keyVar) {
          newCtx = withVar(newCtx, field.keyVar, fieldValue);
        }
        const result = bindPattern(newCtx, field.pattern, fieldValue);
        if (result === null) return null;
        newCtx = result;
      }
      return newCtx;
    }
  }
}

function getValueAtPath(
  root: QueryValue,
  path: (string | number)[]
): QueryValue {
  let v = root;
  for (const key of path) {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        if (typeof key === "number") {
          v = v[key];
        } else {
          return undefined;
        }
      } else {
        // Defense against prototype pollution: only access own properties
        const obj = asQueryRecord(v);
        if (obj && typeof key === "string" && Object.hasOwn(obj, key)) {
          v = obj[key];
        } else {
          return undefined;
        }
      }
    } else {
      return undefined;
    }
  }
  return v;
}

/**
 * Extract a simple path from an AST node (e.g., .a.b.c -> ["a", "b", "c"])
 * Returns null if the AST is not a simple path expression.
 * Handles Pipe nodes with parent/root to track path adjustments.
 */
function extractPathFromAst(ast: AstNode): (string | number)[] | null {
  if (ast.type === "Identity") return [];
  if (ast.type === "Field") {
    const basePath = ast.base ? extractPathFromAst(ast.base) : [];
    if (basePath === null) return null;
    return [...basePath, ast.name];
  }
  if (ast.type === "Index" && ast.index.type === "Literal") {
    const basePath = ast.base ? extractPathFromAst(ast.base) : [];
    if (basePath === null) return null;
    const idx = ast.index.value;
    if (typeof idx === "number" || typeof idx === "string") {
      return [...basePath, idx];
    }
    return null;
  }
  // Handle Pipe nodes to track path through parent/root calls
  if (ast.type === "Pipe") {
    const leftPath = extractPathFromAst(ast.left);
    if (leftPath === null) return null;
    // Apply right side transformation to the path
    return applyPathTransform(leftPath, ast.right);
  }
  // Handle parent/root builtins for path adjustment
  if (ast.type === "Call") {
    if (ast.name === "parent") {
      // parent without context returns null (needs base path from pipe)
      return null;
    }
    if (ast.name === "root") {
      // root resets to document root
      return null;
    }
    // first without args is .[0], last without args is .[-1]
    if (ast.name === "first" && ast.args.length === 0) {
      return [0];
    }
    if (ast.name === "last" && ast.args.length === 0) {
      return [-1];
    }
  }
  // For other node types, we can't extract a simple path
  return null;
}

/**
 * Apply a path transformation (like parent or root) to a base path.
 */
function applyPathTransform(
  basePath: (string | number)[],
  ast: AstNode
): (string | number)[] | null {
  if (ast.type === "Call") {
    if (ast.name === "parent") {
      // Get levels - default is 1, or extract from literal arg
      let levels = 1;
      if (ast.args.length > 0 && ast.args[0].type === "Literal") {
        const arg = ast.args[0].value;
        if (typeof arg === "number") levels = arg;
      }
      if (levels >= 0) {
        // Positive: go up n levels
        return basePath.slice(0, Math.max(0, basePath.length - levels));
      } else {
        // Negative: index from root (-1 = root, -2 = one below root)
        const targetLen = -levels - 1;
        return basePath.slice(0, Math.min(targetLen, basePath.length));
      }
    }
    if (ast.name === "root") {
      return [];
    }
  }
  // For Field/Index on right side, extend the path
  if (ast.type === "Field") {
    const rightPath = extractPathFromAst(ast);
    if (rightPath !== null) {
      return [...basePath, ...rightPath];
    }
  }
  if (ast.type === "Index" && ast.index.type === "Literal") {
    const rightPath = extractPathFromAst(ast);
    if (rightPath !== null) {
      return [...basePath, ...rightPath];
    }
  }
  // For nested pipes, recurse
  if (ast.type === "Pipe") {
    const afterLeft = applyPathTransform(basePath, ast.left);
    if (afterLeft === null) return null;
    return applyPathTransform(afterLeft, ast.right);
  }
  // Identity doesn't change path
  if (ast.type === "Identity") {
    return basePath;
  }
  // For other transformations, we lose path tracking
  return null;
}

export interface EvaluateOptions {
  limits?: QueryExecutionLimits;
  env?: Map<string, string>;
}

/**
 * Evaluate an expression and return partial results even if an error occurs.
 * Used for functions like isempty() that need to know if ANY value was produced.
 */
function evaluateWithPartialResults(
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
): QueryValue[] {
  // For comma expressions, try to get partial results
  if (ast.type === "Comma") {
    const results: QueryValue[] = [];
    try {
      results.push(...evaluate(value, ast.left, ctx));
    } catch (e) {
      // Always re-throw execution limit errors - they must not be suppressed
      if (e instanceof ExecutionLimitError) throw e;
      // Left side errored, check if we have any results
      if (results.length > 0) return results;
      throw new Error("evaluation failed");
    }
    try {
      results.push(...evaluate(value, ast.right, ctx));
    } catch (e) {
      // Always re-throw execution limit errors
      if (e instanceof ExecutionLimitError) throw e;
      // Right side errored, return what we have from left
      return results;
    }
    return results;
  }
  // For other expressions, use normal evaluation
  return evaluate(value, ast, ctx);
}

export function evaluate(
  value: QueryValue,
  ast: AstNode,
  ctxOrOptions?: EvalContext | EvaluateOptions
): QueryValue[] {
  let ctx: EvalContext =
    ctxOrOptions && "vars" in ctxOrOptions
      ? ctxOrOptions
      : createContext(ctxOrOptions as EvaluateOptions | undefined);

  if (!ctx.defenseContextChecked) {
    ctx = { ...ctx, defenseContextChecked: true };
  }

  // Initialize root if not set (first evaluation)
  if (ctx.root === undefined) {
    ctx = { ...ctx, root: value, currentPath: [] };
  }
  switch (ast.type) {
    case "Identity":
      return [value];

    case "Field": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        const obj = asQueryRecord(v);
        if (obj) {
          // Defense against prototype pollution: only return own properties
          // This prevents access to inherited methods like __defineGetter__, constructor, etc.
          if (!Object.hasOwn(obj, ast.name)) {
            return [null];
          }
          const result = obj[ast.name];
          return [result === undefined ? null : result];
        }
        // jq: indexing null always returns null
        if (v === null) {
          return [null];
        }
        // jq throws an error when accessing a field on non-objects (arrays, numbers, strings, booleans)
        // This allows Try (.foo?) to catch it and return empty
        const typeName = Array.isArray(v) ? "array" : typeof v;
        throw new Error(`Cannot index ${typeName} with string "${ast.name}"`);
      });
    }

    case "Index": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        const indices = evaluate(v, ast.index, ctx);
        return indices.flatMap((idx) => {
          if (typeof idx === "number" && Array.isArray(v)) {
            // Handle NaN - return null for NaN index
            if (Number.isNaN(idx)) {
              return [null];
            }
            // Truncate float index to integer (jq behavior)
            const truncated = Math.trunc(idx);
            const i = truncated < 0 ? v.length + truncated : truncated;
            return i >= 0 && i < v.length ? [v[i]] : [null];
          }
          if (typeof idx === "string") {
            // Defense against prototype pollution: only return own properties
            const obj = asQueryRecord(v);
            if (!obj || !Object.hasOwn(obj, idx)) {
              return [null];
            }
            return [obj[idx]];
          }
          return [null];
        });
      });
    }

    case "Slice": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        // null can be sliced and returns null
        if (v === null) return [null];
        if (!Array.isArray(v) && typeof v !== "string") {
          throw new Error(`Cannot slice ${typeof v} (${JSON.stringify(v)})`);
        }
        const len = v.length;
        const starts = ast.start ? evaluate(value, ast.start, ctx) : [0];
        const ends = ast.end ? evaluate(value, ast.end, ctx) : [len];
        return starts.flatMap((s) =>
          ends.map((e) => {
            // jq uses floor for start and ceil for end (for fractional indices)
            // NaN in start position → 0, NaN in end position → length
            const sNum = s as number;
            const eNum = e as number;
            const startRaw = Number.isNaN(sNum)
              ? 0
              : Number.isInteger(sNum)
                ? sNum
                : Math.floor(sNum);
            const endRaw = Number.isNaN(eNum)
              ? len
              : Number.isInteger(eNum)
                ? eNum
                : Math.ceil(eNum);
            const start = normalizeIndex(startRaw, len);
            const end = normalizeIndex(endRaw, len);
            return Array.isArray(v) ? v.slice(start, end) : v.slice(start, end);
          })
        );
      });
    }

    case "Iterate": {
      const bases = ast.base ? evaluate(value, ast.base, ctx) : [value];
      return bases.flatMap((v) => {
        if (Array.isArray(v)) return v;
        if (v && typeof v === "object") return Object.values(v);
        return [];
      });
    }

    case "Pipe": {
      const leftResults = evaluate(value, ast.left, ctx);
      const leftPath = extractPathFromAst(ast.left);
      const pipeResults: QueryValue[] = [];
      for (const v of leftResults) {
        try {
          if (leftPath !== null) {
            const newCtx = {
              ...ctx,
              currentPath: [...(ctx.currentPath ?? []), ...leftPath]
            };
            pipeResults.push(...evaluate(v, ast.right, newCtx));
          } else {
            pipeResults.push(...evaluate(v, ast.right, ctx));
          }
        } catch (e) {
          if (e instanceof BreakError) {
            throw e.withPrependedResults(pipeResults);
          }
          throw e;
        }
      }
      return pipeResults;
    }
    case "Comma": {
      const leftResults = evaluate(value, ast.left, ctx);
      const rightResults = evaluate(value, ast.right, ctx);
      return [...leftResults, ...rightResults];
    }

    case "Literal":
      return [ast.value];

    case "Array": {
      if (!ast.elements) return [[]];
      const elements = evaluate(value, ast.elements, ctx);
      return [elements];
    }

    case "Object": {
      const results: Record<string, unknown>[] = [Object.create(null)];

      for (const entry of ast.entries) {
        const keys =
          typeof entry.key === "string"
            ? [entry.key]
            : evaluate(value, entry.key, ctx);
        const values = evaluate(value, entry.value, ctx);

        // @banned-pattern-ignore: array declaration, objects added via nullPrototypeCopy
        const newResults: Record<string, unknown>[] = [];
        for (const obj of results) {
          for (const k of keys) {
            // jq requires object keys to be strings
            if (typeof k !== "string") {
              const typeName =
                k === null ? "null" : Array.isArray(k) ? "array" : typeof k;
              throw new Error(
                `Cannot use ${typeName} (${JSON.stringify(k)}) as object key`
              );
            }
            // Defense against prototype pollution: skip dangerous keys
            if (!isSafeKey(k)) {
              // Still produce output but without the dangerous key
              for (const _v of values) {
                newResults.push(nullPrototypeCopy(obj));
              }
              continue;
            }
            for (const v of values) {
              const newObj = nullPrototypeCopy(obj);
              safeSet(newObj, k, v);
              newResults.push(newObj);
            }
          }
        }
        results.length = 0;
        results.push(...newResults);
      }

      return results;
    }

    case "Paren":
      return evaluate(value, ast.expr, ctx);

    case "BinaryOp":
      return evalBinaryOp(value, ast.op, ast.left, ast.right, ctx);

    case "UnaryOp": {
      const operands = evaluate(value, ast.operand, ctx);
      return operands.map((v) => {
        if (ast.op === "-") {
          if (typeof v === "number") return -v;
          if (typeof v === "string") {
            // jq: strings cannot be negated - format truncates long strings
            // jq format: "string (\"truncated...) - no closing quote when truncated
            const formatStr = (s: string) =>
              s.length > 5 ? `"${s.slice(0, 3)}...` : JSON.stringify(s);
            throw new Error(`string (${formatStr(v)}) cannot be negated`);
          }
          return null;
        }
        if (ast.op === "not") return !isTruthy(v);
        return null;
      });
    }

    case "Cond": {
      const conds = evaluate(value, ast.cond, ctx);
      return conds.flatMap((c) => {
        if (isTruthy(c)) {
          return evaluate(value, ast.then, ctx);
        }
        for (const elif of ast.elifs) {
          const elifConds = evaluate(value, elif.cond, ctx);
          if (elifConds.some(isTruthy)) {
            return evaluate(value, elif.then, ctx);
          }
        }
        if (ast.else) {
          return evaluate(value, ast.else, ctx);
        }
        // jq: if no else clause and condition is false, return input unchanged
        return [value];
      });
    }

    case "Try": {
      try {
        return evaluate(value, ast.body, ctx);
      } catch (e) {
        if (ast.catch) {
          // jq: In catch handler, input is the error value (preserved if JqError)
          const errorVal =
            e instanceof JqError
              ? e.value
              : e instanceof Error
                ? e.message
                : String(e);
          return evaluate(errorVal, ast.catch, ctx);
        }
        return [];
      }
    }

    case "Call":
      return evalBuiltin(value, ast.name, ast.args, ctx);

    case "VarBind": {
      const values = evaluate(value, ast.value, ctx);
      return values.flatMap((v) => {
        let newCtx: EvalContext | null = null;

        // Build list of patterns to try: primary pattern + alternatives
        const patternsToTry: DestructurePattern[] = [];
        if (ast.pattern) {
          patternsToTry.push(ast.pattern);
        } else if (ast.name) {
          patternsToTry.push({ type: "var", name: ast.name });
        }
        if (ast.alternatives) {
          patternsToTry.push(...ast.alternatives);
        }

        // Try each pattern until one matches
        for (const pattern of patternsToTry) {
          newCtx = bindPattern(ctx, pattern, v);
          if (newCtx !== null) {
            break; // Pattern matched
          }
        }

        if (newCtx === null) {
          // No pattern matched - skip this value
          return [];
        }

        return evaluate(value, ast.body, newCtx);
      });
    }

    case "VarRef": {
      // Special case: $ENV returns environment variables
      // Note: ast.name includes the $ prefix (e.g., "$ENV")
      if (ast.name === "$ENV") {
        // Convert Map to object for jq's internal representation (null-prototype prevents prototype pollution)
        return [ctx.env ? mapToRecord(ctx.env) : Object.create(null)];
      }
      const v = ctx.vars.get(ast.name);
      return v !== undefined ? [v] : [null];
    }

    case "Recurse": {
      const results: QueryValue[] = [];
      const seen = new WeakSet<object>();
      const walk = (val: QueryValue) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) return;
          seen.add(val as object);
        }
        results.push(val);
        if (Array.isArray(val)) {
          for (const item of val) walk(item);
        } else if (val && typeof val === "object") {
          // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
          for (const key of Object.keys(val)) {
            walk((val as Record<string, unknown>)[key]);
          }
        }
      };
      walk(value);
      return results;
    }

    case "Optional": {
      try {
        return evaluate(value, ast.expr, ctx);
      } catch {
        return [];
      }
    }

    case "StringInterp": {
      const parts = ast.parts.map((part) => {
        if (typeof part === "string") return part;
        const vals = evaluate(value, part, ctx);
        return vals
          .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
          .join("");
      });
      return [parts.join("")];
    }

    case "UpdateOp": {
      return [applyUpdate(value, ast.path, ast.op, ast.value, ctx)];
    }

    case "Reduce": {
      const items = evaluate(value, ast.expr, ctx);
      let accumulator = evaluate(value, ast.init, ctx)[0];
      const maxDepth = ctx.limits.maxDepth ?? DEFAULT_MAX_JQ_DEPTH;
      for (const item of items) {
        let newCtx: EvalContext | null;
        if (ast.pattern) {
          newCtx = bindPattern(ctx, ast.pattern, item);
          if (newCtx === null) continue; // Pattern doesn't match, skip
        } else {
          newCtx = withVar(ctx, ast.varName, item);
        }
        accumulator = evaluate(accumulator, ast.update, newCtx)[0];
        // Check depth limit to prevent stack overflow with deeply nested structures
        if (getValueDepth(accumulator, maxDepth + 1) > maxDepth) {
          return [null];
        }
      }
      return [accumulator];
    }

    case "Foreach": {
      const items = evaluate(value, ast.expr, ctx);
      let state = evaluate(value, ast.init, ctx)[0];
      const foreachResults: QueryValue[] = [];
      for (const item of items) {
        try {
          let newCtx: EvalContext | null;
          if (ast.pattern) {
            newCtx = bindPattern(ctx, ast.pattern, item);
            if (newCtx === null) continue; // Pattern doesn't match, skip
          } else {
            newCtx = withVar(ctx, ast.varName, item);
          }
          state = evaluate(state, ast.update, newCtx)[0];
          if (ast.extract) {
            const extracted = evaluate(state, ast.extract, newCtx);
            foreachResults.push(...extracted);
          } else {
            foreachResults.push(state);
          }
        } catch (e) {
          if (e instanceof BreakError) {
            throw e.withPrependedResults(foreachResults);
          }
          throw e;
        }
      }
      return foreachResults;
    }

    case "Label": {
      try {
        return evaluate(value, ast.body, {
          ...ctx,
          labels: new Set([...(ctx.labels ?? []), ast.name])
        });
      } catch (e) {
        if (e instanceof BreakError && e.label === ast.name) {
          return e.partialResults;
        }
        throw e;
      }
    }

    case "Break": {
      throw new BreakError(ast.name);
    }

    case "Def": {
      // Register the function in context and evaluate the body
      // Functions are keyed by name/arity to allow overloading (e.g., def f: ...; def f(a): ...)
      // Store closure (current funcs map) for lexical scoping
      const newFuncs = new Map(ctx.funcs ?? []);
      const funcKey = `${ast.name}/${ast.params.length}`;
      // Capture the current funcs map as the closure for this function
      newFuncs.set(funcKey, {
        params: ast.params,
        body: ast.funcBody,
        closure: new Map(ctx.funcs ?? [])
      });
      const newCtx: EvalContext = { ...ctx, funcs: newFuncs };
      return evaluate(value, ast.body, newCtx);
    }

    default: {
      const _exhaustive: never = ast;
      throw new Error(
        `Unknown AST node type: ${(_exhaustive as AstNode).type}`
      );
    }
  }
}

function normalizeIndex(idx: number, len: number): number {
  if (idx < 0) return Math.max(0, len + idx);
  return Math.min(idx, len);
}

function applyUpdate(
  root: QueryValue,
  pathExpr: AstNode,
  op: string,
  valueExpr: AstNode,
  ctx: EvalContext
): QueryValue {
  function computeNewValue(
    current: QueryValue,
    newVal: QueryValue
  ): QueryValue {
    switch (op) {
      case "=":
        return newVal;
      case "|=": {
        const results = evaluate(current, valueExpr, ctx);
        return results[0] ?? null;
      }
      case "+=":
        if (typeof current === "number" && typeof newVal === "number")
          return current + newVal;
        if (typeof current === "string" && typeof newVal === "string")
          return current + newVal;
        if (Array.isArray(current) && Array.isArray(newVal))
          return [...current, ...newVal];
        if (
          current &&
          newVal &&
          typeof current === "object" &&
          typeof newVal === "object"
        ) {
          return nullPrototypeMerge(current, newVal);
        }
        return newVal;
      case "-=":
        if (typeof current === "number" && typeof newVal === "number")
          return current - newVal;
        return current;
      case "*=":
        if (typeof current === "number" && typeof newVal === "number")
          return current * newVal;
        return current;
      case "/=":
        if (typeof current === "number" && typeof newVal === "number")
          return current / newVal;
        return current;
      case "%=":
        if (typeof current === "number" && typeof newVal === "number")
          return current % newVal;
        return current;
      case "//=":
        return current === null || current === false ? newVal : current;
      default:
        return newVal;
    }
  }

  function updateRecursive(
    val: QueryValue,
    path: AstNode,
    transform: (current: QueryValue) => QueryValue
  ): QueryValue {
    switch (path.type) {
      case "Identity":
        return transform(val);

      case "Field": {
        // Defense against prototype pollution: skip dangerous keys
        if (!isSafeKey(path.name)) {
          return val;
        }
        if (path.base) {
          return updateRecursive(val, path.base, (baseVal) => {
            if (
              baseVal &&
              typeof baseVal === "object" &&
              !Array.isArray(baseVal)
            ) {
              const obj = nullPrototypeCopy(baseVal);
              const current = Object.hasOwn(obj, path.name)
                ? obj[path.name]
                : undefined;
              safeSet(obj, path.name, transform(current));
              return obj;
            }
            return baseVal;
          });
        }
        if (val && typeof val === "object" && !Array.isArray(val)) {
          const obj = nullPrototypeCopy(val);
          const current = Object.hasOwn(obj, path.name)
            ? obj[path.name]
            : undefined;
          safeSet(obj, path.name, transform(current));
          return obj;
        }
        return val;
      }

      case "Index": {
        const indices = evaluate(root, path.index, ctx);
        let idx = indices[0];

        // Handle NaN index - throw error for assignment
        if (typeof idx === "number" && Number.isNaN(idx)) {
          throw new Error("Cannot set array element at NaN index");
        }

        // Truncate float index to integer for assignment
        if (typeof idx === "number" && !Number.isInteger(idx)) {
          idx = Math.trunc(idx);
        }

        if (path.base) {
          return updateRecursive(val, path.base, (baseVal) => {
            if (typeof idx === "number" && Array.isArray(baseVal)) {
              const arr = [...baseVal];
              const i = idx < 0 ? arr.length + idx : idx;
              if (i >= 0) {
                // Extend array if needed
                while (arr.length <= i) arr.push(null);
                arr[i] = transform(arr[i]);
              }
              return arr;
            }
            if (
              typeof idx === "string" &&
              baseVal &&
              typeof baseVal === "object" &&
              !Array.isArray(baseVal)
            ) {
              // Defense against prototype pollution: skip dangerous keys
              if (!isSafeKey(idx)) {
                return baseVal;
              }
              const obj = nullPrototypeCopy(baseVal);
              const current = Object.hasOwn(obj, idx) ? obj[idx] : undefined;
              safeSet(obj, idx, transform(current));
              return obj;
            }
            return baseVal;
          });
        }

        if (typeof idx === "number") {
          // jq: Array index too large
          const MAX_ARRAY_INDEX = 536870911;
          if (idx > MAX_ARRAY_INDEX) {
            throw new Error("Array index too large");
          }
          // jq: Out of bounds negative array index when base is null/non-array
          if (idx < 0 && (!val || !Array.isArray(val))) {
            throw new Error("Out of bounds negative array index");
          }
          if (Array.isArray(val)) {
            const arr = [...val];
            const i = idx < 0 ? arr.length + idx : idx;
            if (i >= 0) {
              // Extend array if needed
              while (arr.length <= i) arr.push(null);
              arr[i] = transform(arr[i]);
            }
            return arr;
          }
          // Create array if val is null
          if (val === null || val === undefined) {
            const arr: QueryValue[] = [];
            while (arr.length <= idx) arr.push(null);
            arr[idx] = transform(null);
            return arr;
          }
          return val;
        }
        if (
          typeof idx === "string" &&
          val &&
          typeof val === "object" &&
          !Array.isArray(val)
        ) {
          // Defense against prototype pollution: skip dangerous keys
          if (!isSafeKey(idx)) {
            return val;
          }
          const obj = nullPrototypeCopy(val);
          const current = Object.hasOwn(obj, idx) ? obj[idx] : undefined;
          safeSet(obj, idx, transform(current));
          return obj;
        }
        return val;
      }

      case "Iterate": {
        const applyToContainer = (container: QueryValue): QueryValue => {
          if (Array.isArray(container)) {
            return container.map((item) => transform(item));
          }
          if (container && typeof container === "object") {
            // Use null-prototype to prevent prototype pollution
            const obj: Record<string, unknown> = Object.create(null);
            for (const [k, v] of Object.entries(container)) {
              // Defense against prototype pollution: skip dangerous keys
              if (isSafeKey(k)) {
                safeSet(obj, k, transform(v));
              }
            }
            return obj;
          }
          return container;
        };

        if (path.base) {
          return updateRecursive(val, path.base, applyToContainer);
        }
        return applyToContainer(val);
      }

      case "Pipe": {
        const leftResult = updateRecursive(val, path.left, (x) => x);
        return updateRecursive(leftResult, path.right, transform);
      }

      default:
        return transform(val);
    }
  }

  const transformer = (current: QueryValue): QueryValue => {
    if (op === "|=") {
      return computeNewValue(current, current);
    }
    const newVals = evaluate(root, valueExpr, ctx);
    return computeNewValue(current, newVals[0] ?? null);
  };

  return updateRecursive(root, pathExpr, transformer);
}

function applyDel(
  root: QueryValue,
  pathExpr: AstNode,
  ctx: EvalContext
): QueryValue {
  // Helper to set a value at an AST path
  function setAtPath(
    obj: QueryValue,
    pathNode: AstNode,
    newVal: QueryValue
  ): QueryValue {
    switch (pathNode.type) {
      case "Identity":
        return newVal;
      case "Field": {
        // Defense against prototype pollution: skip dangerous keys
        if (!isSafeKey(pathNode.name)) {
          return obj;
        }
        if (pathNode.base) {
          // Nested field: recurse into base
          const nested = evaluate(obj, pathNode.base, ctx)[0];
          const modified = setAtPath(
            nested,
            { type: "Field", name: pathNode.name },
            newVal
          );
          return setAtPath(obj, pathNode.base, modified);
        }
        // Direct field
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const result = nullPrototypeCopy(obj);
          safeSet(result, pathNode.name, newVal);
          return result;
        }
        return obj;
      }
      case "Index": {
        if (pathNode.base) {
          // Nested index: recurse into base
          const nested = evaluate(obj, pathNode.base, ctx)[0];
          const modified = setAtPath(
            nested,
            { type: "Index", index: pathNode.index },
            newVal
          );
          return setAtPath(obj, pathNode.base, modified);
        }
        // Direct index
        const indices = evaluate(root, pathNode.index, ctx);
        const idx = indices[0];
        if (typeof idx === "number" && Array.isArray(obj)) {
          const arr = [...obj];
          const i = idx < 0 ? arr.length + idx : idx;
          if (i >= 0 && i < arr.length) {
            arr[i] = newVal;
          }
          return arr;
        }
        if (
          typeof idx === "string" &&
          obj &&
          typeof obj === "object" &&
          !Array.isArray(obj)
        ) {
          // Defense against prototype pollution: skip dangerous keys
          if (!isSafeKey(idx)) {
            return obj;
          }
          const result = nullPrototypeCopy(obj);
          safeSet(result, idx, newVal);
          return result;
        }
        return obj;
      }
      default:
        return obj;
    }
  }

  function deleteAt(val: QueryValue, path: AstNode): QueryValue {
    switch (path.type) {
      case "Identity":
        return null;

      case "Field": {
        // Defense against prototype pollution: skip dangerous keys
        if (!isSafeKey(path.name)) {
          return val;
        }
        // If there's a base (nested field like .a.b), recurse
        if (path.base) {
          // Evaluate base to get the nested object
          const nested = evaluate(val, path.base, ctx)[0];
          if (nested === null || nested === undefined) {
            return val;
          }
          // Delete field from nested object
          const modified = deleteAt(nested, { type: "Field", name: path.name });
          // Set the modified value back at the base path
          return setAtPath(val, path.base, modified);
        }
        // Direct field deletion (no base)
        if (val && typeof val === "object" && !Array.isArray(val)) {
          // Defense against prototype pollution: skip dangerous keys
          if (!isSafeKey(path.name)) {
            return val;
          }
          const obj = nullPrototypeCopy(val);
          delete obj[path.name];
          return obj;
        }
        return val;
      }

      case "Index": {
        // If there's a base (nested index like .[0].a), recurse
        if (path.base) {
          // Evaluate base to get the nested object/array
          const nested = evaluate(val, path.base, ctx)[0];
          if (nested === null || nested === undefined) {
            return val;
          }
          // Delete at index from nested value
          const modified = deleteAt(nested, {
            type: "Index",
            index: path.index
          });
          // Set the modified value back at the base path
          return setAtPath(val, path.base, modified);
        }

        const indices = evaluate(root, path.index, ctx);
        const idx = indices[0];

        if (typeof idx === "number" && Array.isArray(val)) {
          const arr = [...val];
          const i = idx < 0 ? arr.length + idx : idx;
          if (i >= 0 && i < arr.length) {
            arr.splice(i, 1);
          }
          return arr;
        }
        if (
          typeof idx === "string" &&
          val &&
          typeof val === "object" &&
          !Array.isArray(val)
        ) {
          // Defense against prototype pollution: skip dangerous keys
          if (!isSafeKey(idx)) {
            return val;
          }
          const obj = nullPrototypeCopy(val);
          delete obj[idx];
          return obj;
        }
        return val;
      }

      case "Iterate": {
        if (Array.isArray(val)) {
          return [];
        }
        if (val && typeof val === "object") {
          return Object.create(null);
        }
        return val;
      }

      case "Pipe": {
        // For nested paths like .a.b, navigate to .a and delete .b within it
        const leftPath = path.left;
        const rightPath = path.right;

        // Helper to set a value at an AST path
        function setAt(
          obj: QueryValue,
          pathNode: AstNode,
          newVal: QueryValue
        ): QueryValue {
          switch (pathNode.type) {
            case "Identity":
              return newVal;
            case "Field": {
              // Defense against prototype pollution: skip dangerous keys
              if (!isSafeKey(pathNode.name)) {
                return obj;
              }
              if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                const result = nullPrototypeCopy(obj);
                safeSet(result, pathNode.name, newVal);
                return result;
              }
              return obj;
            }
            case "Index": {
              const indices = evaluate(root, pathNode.index, ctx);
              const idx = indices[0];
              if (typeof idx === "number" && Array.isArray(obj)) {
                const arr = [...obj];
                const i = idx < 0 ? arr.length + idx : idx;
                if (i >= 0 && i < arr.length) {
                  arr[i] = newVal;
                }
                return arr;
              }
              if (
                typeof idx === "string" &&
                obj &&
                typeof obj === "object" &&
                !Array.isArray(obj)
              ) {
                // Defense against prototype pollution: skip dangerous keys
                if (!isSafeKey(idx)) {
                  return obj;
                }
                const result = nullPrototypeCopy(obj);
                safeSet(result, idx, newVal);
                return result;
              }
              return obj;
            }
            case "Pipe": {
              // Recurse: set at leftPath with the result of setting at rightPath
              const innerVal = evaluate(obj, pathNode.left, ctx)[0];
              const modified = setAt(innerVal, pathNode.right, newVal);
              return setAt(obj, pathNode.left, modified);
            }
            default:
              return obj;
          }
        }

        // Get the current value at the left path
        const nested = evaluate(val, leftPath, ctx)[0];
        if (nested === null || nested === undefined) {
          return val; // Nothing to delete
        }

        // Apply deletion on the nested value
        const modified = deleteAt(nested, rightPath);

        // Reconstruct the object with the modified nested value
        return setAt(val, leftPath, modified);
      }

      default:
        return val;
    }
  }

  return deleteAt(root, pathExpr);
}

function evalBinaryOp(
  value: QueryValue,
  op: string,
  left: AstNode,
  right: AstNode,
  ctx: EvalContext
): QueryValue[] {
  // Short-circuit for 'and' and 'or'
  if (op === "and") {
    const leftVals = evaluate(value, left, ctx);
    return leftVals.flatMap((l) => {
      if (!isTruthy(l)) return [false];
      const rightVals = evaluate(value, right, ctx);
      return rightVals.map((r) => isTruthy(r));
    });
  }

  if (op === "or") {
    const leftVals = evaluate(value, left, ctx);
    return leftVals.flatMap((l) => {
      if (isTruthy(l)) return [true];
      const rightVals = evaluate(value, right, ctx);
      return rightVals.map((r) => isTruthy(r));
    });
  }

  if (op === "//") {
    const leftVals = evaluate(value, left, ctx);
    const nonNull = leftVals.filter(
      (v) => v !== null && v !== undefined && v !== false
    );
    if (nonNull.length > 0) return nonNull;
    return evaluate(value, right, ctx);
  }

  const leftVals = evaluate(value, left, ctx);
  const rightVals = evaluate(value, right, ctx);

  return leftVals.flatMap((l) =>
    rightVals.map((r) => {
      switch (op) {
        case "+":
          // jq: null + x = x, x + null = x
          if (l === null) return r;
          if (r === null) return l;
          if (typeof l === "number" && typeof r === "number") return l + r;
          if (typeof l === "string" && typeof r === "string") return l + r;
          if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
          if (
            l &&
            r &&
            typeof l === "object" &&
            typeof r === "object" &&
            !Array.isArray(l) &&
            !Array.isArray(r)
          ) {
            return nullPrototypeMerge(l, r);
          }
          return null;
        case "-":
          if (typeof l === "number" && typeof r === "number") return l - r;
          if (Array.isArray(l) && Array.isArray(r)) {
            const rSet = new Set(r.map((x) => JSON.stringify(x)));
            return l.filter((x) => !rSet.has(JSON.stringify(x)));
          }
          if (typeof l === "string" && typeof r === "string") {
            // jq: strings cannot be subtracted - format truncates long strings
            // jq format: "string (\"truncated...) - no closing quote when truncated
            const formatStr = (s: string) =>
              s.length > 10 ? `"${s.slice(0, 10)}...` : JSON.stringify(s);
            throw new Error(
              `string (${formatStr(l)}) and string (${formatStr(r)}) cannot be subtracted`
            );
          }
          return null;
        case "*":
          if (typeof l === "number" && typeof r === "number") return l * r;
          if (typeof l === "string" && typeof r === "number")
            return l.repeat(r);
          {
            const lObj = asQueryRecord(l);
            const rObj = asQueryRecord(r);
            if (lObj && rObj) {
              return deepMerge(lObj, rObj);
            }
          }
          return null;
        case "/":
          if (typeof l === "number" && typeof r === "number") {
            if (r === 0) {
              throw new Error(
                `number (${l}) and number (${r}) cannot be divided because the divisor is zero`
              );
            }
            return l / r;
          }
          if (typeof l === "string" && typeof r === "string") return l.split(r);
          return null;
        case "%":
          if (typeof l === "number" && typeof r === "number") {
            if (r === 0) {
              throw new Error(
                `number (${l}) and number (${r}) cannot be divided (remainder) because the divisor is zero`
              );
            }
            // jq: special handling for infinity modulo (but not NaN)
            if (!Number.isFinite(l) && !Number.isNaN(l)) {
              if (!Number.isFinite(r) && !Number.isNaN(r)) {
                // -infinity % infinity = -1, others = 0
                return l < 0 && r > 0 ? -1 : 0;
              }
              // infinity % finite = 0
              return 0;
            }
            return l % r;
          }
          return null;
        case "==":
          return deepEqual(l, r);
        case "!=":
          return !deepEqual(l, r);
        case "<":
          return compare(l, r) < 0;
        case "<=":
          return compare(l, r) <= 0;
        case ">":
          return compare(l, r) > 0;
        case ">=":
          return compare(l, r) >= 0;
        default:
          return null;
      }
    })
  );
}

// ============================================================================
// Builtins
// ============================================================================

function evalBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext
): QueryValue[] {
  // Handle simple single-argument math functions via lookup table
  const simpleMathFn = SIMPLE_MATH_FUNCTIONS.get(name);
  if (simpleMathFn) {
    if (typeof value === "number") return [simpleMathFn(value)];
    return [null];
  }

  // Delegate to extracted builtin handlers
  const mathResult = evalMathBuiltin(value, name, args, ctx, evaluate);
  if (mathResult !== null) return mathResult;

  const stringResult = evalStringBuiltin(value, name, args, ctx, evaluate);
  if (stringResult !== null) return stringResult;

  const dateResult = evalDateBuiltin(value, name, args, ctx, evaluate);
  if (dateResult !== null) return dateResult;

  const formatResult = evalFormatBuiltin(value, name, ctx.limits.maxDepth);
  if (formatResult !== null) return formatResult;

  const typeResult = evalTypeBuiltin(value, name);
  if (typeResult !== null) return typeResult;

  const objectResult = evalObjectBuiltin(value, name, args, ctx, evaluate);
  if (objectResult !== null) return objectResult;

  const arrayResult = evalArrayBuiltin(
    value,
    name,
    args,
    ctx,
    evaluate,
    evaluateWithPartialResults,
    compareJq,
    isTruthy,
    containsDeep,
    ExecutionLimitError
  );
  if (arrayResult !== null) return arrayResult;

  const pathResult = evalPathBuiltin(
    value,
    name,
    args,
    ctx,
    evaluate,
    isTruthy,
    setPath,
    deletePath,
    applyDel,
    collectPaths
  );
  if (pathResult !== null) return pathResult;

  const indexResult = evalIndexBuiltin(
    value,
    name,
    args,
    ctx,
    evaluate,
    deepEqual
  );
  if (indexResult !== null) return indexResult;

  const controlResult = evalControlBuiltin(
    value,
    name,
    args,
    ctx,
    evaluate,
    evaluateWithPartialResults,
    isTruthy,
    ExecutionLimitError
  );
  if (controlResult !== null) return controlResult;

  const navigationResult = evalNavigationBuiltin(
    value,
    name,
    args,
    ctx,
    evaluate,
    isTruthy,
    getValueAtPath,
    evalBuiltin
  );
  if (navigationResult !== null) return navigationResult;

  const sqlResult = evalSqlBuiltin(value, name, args, ctx, evaluate, deepEqual);
  if (sqlResult !== null) return sqlResult;

  switch (name) {
    // keys, keys_unsorted, length, utf8bytelength, type, to_entries, from_entries,
    // with_entries, reverse, flatten, unique, tojson, tojsonstream, fromjson,
    // tostring, tonumber, toboolean, tostream, fromstream, truncate_stream
    // handled by evalObjectBuiltin
    //
    // sort, sort_by, bsearch, unique_by, group_by, max, max_by, min, min_by,
    // add, any, all, select, map, map_values, has, in, contains, inside
    // handled by evalArrayBuiltin
    //
    // getpath, setpath, delpaths, path, del, pick, paths, leaf_paths
    // handled by evalPathBuiltin
    //
    // index, rindex, indices handled by evalIndexBuiltin
    //
    // first, last, nth, range, limit, isempty, isvalid, skip, until, while, repeat
    // handled by evalControlBuiltin
    //
    // recurse, recurse_down, walk, transpose, combinations, parent, parents, root
    // handled by evalNavigationBuiltin
    //
    // IN, INDEX, JOIN handled by evalSqlBuiltin

    case "builtins":
      // Return list of all builtin functions with arity
      return [
        [
          "add/0",
          "all/0",
          "all/1",
          "all/2",
          "any/0",
          "any/1",
          "any/2",
          "arrays/0",
          "ascii/0",
          "ascii_downcase/0",
          "ascii_upcase/0",
          "booleans/0",
          "bsearch/1",
          "builtins/0",
          "combinations/0",
          "combinations/1",
          "contains/1",
          "debug/0",
          "del/1",
          "delpaths/1",
          "empty/0",
          "env/0",
          "error/0",
          "error/1",
          "explode/0",
          "first/0",
          "first/1",
          "flatten/0",
          "flatten/1",
          "floor/0",
          "from_entries/0",
          "fromdate/0",
          "fromjson/0",
          "getpath/1",
          "gmtime/0",
          "group_by/1",
          "gsub/2",
          "gsub/3",
          "has/1",
          "implode/0",
          "IN/1",
          "IN/2",
          "INDEX/1",
          "INDEX/2",
          "index/1",
          "indices/1",
          "infinite/0",
          "inside/1",
          "isempty/1",
          "isnan/0",
          "isnormal/0",
          "isvalid/1",
          "iterables/0",
          "join/1",
          "keys/0",
          "keys_unsorted/0",
          "last/0",
          "last/1",
          "length/0",
          "limit/2",
          "ltrimstr/1",
          "map/1",
          "map_values/1",
          "match/1",
          "match/2",
          "max/0",
          "max_by/1",
          "min/0",
          "min_by/1",
          "mktime/0",
          "modulemeta/1",
          "nan/0",
          "not/0",
          "nth/1",
          "nth/2",
          "null/0",
          "nulls/0",
          "numbers/0",
          "objects/0",
          "path/1",
          "paths/0",
          "paths/1",
          "pick/1",
          "range/1",
          "range/2",
          "range/3",
          "recurse/0",
          "recurse/1",
          "recurse_down/0",
          "repeat/1",
          "reverse/0",
          "rindex/1",
          "rtrimstr/1",
          "scalars/0",
          "scan/1",
          "scan/2",
          "select/1",
          "setpath/2",
          "skip/2",
          "sort/0",
          "sort_by/1",
          "split/1",
          "splits/1",
          "splits/2",
          "sqrt/0",
          "startswith/1",
          "strftime/1",
          "strings/0",
          "strptime/1",
          "sub/2",
          "sub/3",
          "test/1",
          "test/2",
          "to_entries/0",
          "toboolean/0",
          "todate/0",
          "tojson/0",
          "tostream/0",
          "fromstream/1",
          "truncate_stream/1",
          "tonumber/0",
          "tostring/0",
          "transpose/0",
          "trim/0",
          "ltrim/0",
          "rtrim/0",
          "type/0",
          "unique/0",
          "unique_by/1",
          "until/2",
          "utf8bytelength/0",
          "values/0",
          "walk/1",
          "while/2",
          "with_entries/1"
        ]
      ];

    // empty, not, null, true, false handled by evalTypeBuiltin

    case "error": {
      const msg = args.length > 0 ? evaluate(value, args[0], ctx)[0] : value;
      throw new JqError(msg);
    }

    // first, last, nth, range handled by evalControlBuiltin

    // sort, sort_by, bsearch, unique_by, group_by, max, max_by, min, min_by,
    // add, any, all, select, map, map_values, has, in, contains, inside
    // handled by evalArrayBuiltin

    // getpath, setpath, delpaths, path, del, pick, paths, leaf_paths
    // handled by evalPathBuiltin

    // index, rindex, indices handled by evalIndexBuiltin

    case "env":
      // Convert Map to object for jq's internal representation (null-prototype prevents prototype pollution)
      return [ctx.env ? mapToRecord(ctx.env) : Object.create(null)];

    // recurse, recurse_down, walk, transpose, combinations, parent, parents, root
    // handled by evalNavigationBuiltin
    //
    // limit, isempty, isvalid, skip, until, while, repeat
    // handled by evalControlBuiltin

    case "debug":
      return [value];

    case "input_line_number":
      return [1];

    // parents, root handled by evalNavigationBuiltin
    // IN, INDEX, JOIN handled by evalSqlBuiltin

    default: {
      // Check for user-defined function by name/arity
      const funcKey = `${name}/${args.length}`;
      const userFunc = ctx.funcs?.get(funcKey) as
        | { params: string[]; body: AstNode; closure?: Map<string, unknown> }
        | undefined;
      if (userFunc) {
        // User-defined function: bind parameters
        // In jq, parameters are "filters" that can produce multiple values.
        // We evaluate them in the calling context and store as literal values.
        //
        // Use the function's closure for lexical scoping, not the current context's funcs.
        // This ensures that functions capture the scope at definition time.
        const baseFuncs = (userFunc.closure ?? ctx.funcs ?? new Map()) as Map<
          string,
          { params: string[]; body: AstNode; closure?: Map<string, unknown> }
        >;
        const newFuncs = new Map(baseFuncs);
        // Also add the current function itself so recursion works
        newFuncs.set(funcKey, userFunc);
        for (let i = 0; i < userFunc.params.length; i++) {
          const paramName = userFunc.params[i];
          const argExpr = args[i];
          if (argExpr) {
            // Evaluate the argument in the calling context, then store as a literal
            // This implements call-by-value semantics
            const argVals = evaluate(value, argExpr, ctx);
            // Store as a function that returns all the values
            let bodyNode: AstNode;
            if (argVals.length === 0) {
              bodyNode = { type: "Call", name: "empty", args: [] };
            } else if (argVals.length === 1) {
              bodyNode = { type: "Literal", value: argVals[0] };
            } else {
              // Multiple values - build a right-associative Comma chain
              bodyNode = {
                type: "Literal",
                value: argVals[argVals.length - 1]
              };
              for (let j = argVals.length - 2; j >= 0; j--) {
                bodyNode = {
                  type: "Comma",
                  left: { type: "Literal", value: argVals[j] },
                  right: bodyNode
                };
              }
            }
            newFuncs.set(`${paramName}/0`, { params: [], body: bodyNode });
          }
        }
        const newCtx: EvalContext = { ...ctx, funcs: newFuncs };
        return evaluate(value, userFunc.body, newCtx);
      }
      throw new Error(`Unknown function: ${name}`);
    }
  }
}

function collectPaths(
  value: QueryValue,
  expr: AstNode,
  ctx: EvalContext,
  currentPath: (string | number)[],
  paths: (string | number)[][]
): void {
  // Handle Comma - collect paths for both parts
  if (expr.type === "Comma") {
    const comma = expr as { type: "Comma"; left: AstNode; right: AstNode };
    collectPaths(value, comma.left, ctx, currentPath, paths);
    collectPaths(value, comma.right, ctx, currentPath, paths);
    return;
  }

  // Try to extract a static path from the AST
  const staticPath = extractPathFromAst(expr);
  if (staticPath !== null) {
    paths.push([...currentPath, ...staticPath]);
    return;
  }

  // For more complex expressions, evaluate and try to infer paths
  // This handles cases like .[] which produce multiple paths
  if (expr.type === "Iterate") {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        paths.push([...currentPath, i]);
      }
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        paths.push([...currentPath, key]);
      }
    }
    return;
  }

  // Handle Recurse (..) - recursive descent, returns paths to all values
  if (expr.type === "Recurse") {
    const walkPaths = (v: QueryValue, path: (string | number)[]) => {
      paths.push([...currentPath, ...path]);
      if (v && typeof v === "object") {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            walkPaths(v[i], [...path, i]);
          }
        } else {
          // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
          for (const key of Object.keys(v)) {
            walkPaths((v as Record<string, unknown>)[key], [...path, key]);
          }
        }
      }
    };
    walkPaths(value, []);
    return;
  }

  // For Pipe expressions, collect paths through the pipe
  if (expr.type === "Pipe") {
    const leftPath = extractPathFromAst(expr.left);
    if (leftPath !== null) {
      const leftResults = evaluate(value, expr.left, ctx);
      for (const lv of leftResults) {
        collectPaths(lv, expr.right, ctx, [...currentPath, ...leftPath], paths);
      }
      return;
    }
  }

  // Fallback: if expression produces results, push current path
  const results = evaluate(value, expr, ctx);
  if (results.length > 0) {
    paths.push(currentPath);
  }
}
