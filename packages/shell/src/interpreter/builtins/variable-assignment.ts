/**
 * Variable assignment helpers for declare, readonly, local, export builtins.
 */

import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import type { ExecResult } from "../../types";
import { evaluateArithmetic } from "../arithmetic";
import { checkReadonlyError, markReadonly } from "../helpers/readonly";
import type { InterpreterContext } from "../types";
import { parseArrayElements } from "./declare-array-parsing";

/**
 * Result of parsing an assignment argument.
 */
export interface ParsedAssignment {
  name: string;
  isArray: boolean;
  arrayElements?: string[];
  value?: string;
  /** For array index assignment: a[index]=value */
  arrayIndex?: string;
}

/**
 * Parse an assignment argument like "name=value", "name=(a b c)", or "name[index]=value".
 */
export function parseAssignment(arg: string): ParsedAssignment {
  // Check for array assignment: name=(...)
  const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\((.*)\)$/s);
  if (arrayMatch) {
    return {
      name: arrayMatch[1],
      isArray: true,
      arrayElements: parseArrayElements(arrayMatch[2])
    };
  }

  // Check for array index assignment: name[index]=value
  // The index can be an arithmetic expression like 1*1 or 1+2
  const indexMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([^\]]+)\]=(.*)$/s);
  if (indexMatch) {
    return {
      name: indexMatch[1],
      isArray: false,
      arrayIndex: indexMatch[2],
      value: indexMatch[3]
    };
  }

  // Check for scalar assignment: name=value
  if (arg.includes("=")) {
    const eqIdx = arg.indexOf("=");
    return {
      name: arg.slice(0, eqIdx),
      isArray: false,
      value: arg.slice(eqIdx + 1)
    };
  }

  // Just a name, no value
  return {
    name: arg,
    isArray: false
  };
}

/**
 * Options for setting a variable.
 */
export interface SetVariableOptions {
  makeReadonly?: boolean;
  checkReadonly?: boolean;
}

/**
 * Evaluate an array index expression (can be arithmetic).
 */
async function evaluateArrayIndex(
  ctx: InterpreterContext,
  indexExpr: string
): Promise<number> {
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, indexExpr);
    return await evaluateArithmetic(ctx, arithAst.expression);
  } catch {
    // If parsing fails, try to parse as simple number
    const num = parseInt(indexExpr, 10);
    return Number.isNaN(num) ? 0 : num;
  }
}

/**
 * Set a variable from a parsed assignment.
 * Returns an error result if the variable is readonly, otherwise null.
 */
export async function setVariable(
  ctx: InterpreterContext,
  assignment: ParsedAssignment,
  options: SetVariableOptions = {}
): Promise<ExecResult | null> {
  const { name, isArray, arrayElements, value, arrayIndex } = assignment;
  const { makeReadonly = false, checkReadonly = true } = options;

  // Check if variable is readonly (if checking is enabled)
  if (checkReadonly) {
    const error = checkReadonlyError(ctx, name);
    if (error) return error;
  }

  if (isArray && arrayElements) {
    // Set array elements
    for (let i = 0; i < arrayElements.length; i++) {
      ctx.state.env.set(`${name}_${i}`, arrayElements[i]);
    }
    ctx.state.env.set(`${name}__length`, String(arrayElements.length));
  } else if (arrayIndex !== undefined && value !== undefined) {
    // Array index assignment: a[index]=value
    const index = await evaluateArrayIndex(ctx, arrayIndex);
    ctx.state.env.set(`${name}_${index}`, value);
    // Update array length if needed (sparse arrays may have gaps)
    const currentLength = parseInt(
      ctx.state.env.get(`${name}__length`) ?? "0",
      10
    );
    if (index >= currentLength) {
      ctx.state.env.set(`${name}__length`, String(index + 1));
    }
  } else if (value !== undefined) {
    // Set scalar value
    ctx.state.env.set(name, value);
  }

  // Mark as readonly if requested
  if (makeReadonly) {
    markReadonly(ctx, name);
  }

  return null; // Success
}

/**
 * Mark a variable as being declared at the current call depth.
 * Used for bash-specific unset scoping behavior.
 */
export function markLocalVarDepth(ctx: InterpreterContext, name: string): void {
  ctx.state.localVarDepth = ctx.state.localVarDepth || new Map();
  ctx.state.localVarDepth.set(name, ctx.state.callDepth);
}

/**
 * Get the call depth at which a local variable was declared.
 * Returns undefined if the variable is not a local variable.
 */
export function getLocalVarDepth(
  ctx: InterpreterContext,
  name: string
): number | undefined {
  return ctx.state.localVarDepth?.get(name);
}

/**
 * Clear the local variable depth tracking for a variable.
 * Called when a local variable is cell-unset (dynamic-unset).
 */
export function clearLocalVarDepth(
  ctx: InterpreterContext,
  name: string
): void {
  ctx.state.localVarDepth?.delete(name);
}

/**
 * Push the current value of a variable onto the local var stack.
 * Used for bash's localvar-nest behavior where nested local declarations
 * each create a new cell that can be unset independently.
 */
export function pushLocalVarStack(
  ctx: InterpreterContext,
  name: string,
  currentValue: string | undefined
): void {
  ctx.state.localVarStack = ctx.state.localVarStack || new Map();
  const stack = ctx.state.localVarStack.get(name) || [];
  stack.push({
    value: currentValue,
    scopeIndex: ctx.state.localScopes.length - 1
  });
  ctx.state.localVarStack.set(name, stack);
}

/**
 * Pop the top entry from the local var stack for a variable.
 * Returns the saved value and scope index if there was an entry, or undefined if the stack was empty.
 */
export function popLocalVarStack(
  ctx: InterpreterContext,
  name: string
): { value: string | undefined; scopeIndex: number } | undefined {
  const stack = ctx.state.localVarStack?.get(name);
  if (!stack || stack.length === 0) {
    return undefined;
  }
  return stack.pop();
}

/**
 * Clear all local var stack entries for a specific scope index.
 * Called when a function returns and its local scope is popped.
 */
export function clearLocalVarStackForScope(
  ctx: InterpreterContext,
  scopeIndex: number
): void {
  if (!ctx.state.localVarStack) return;

  for (const [name, stack] of ctx.state.localVarStack.entries()) {
    // Remove entries from the top of the stack that belong to this scope
    while (
      stack.length > 0 &&
      stack[stack.length - 1].scopeIndex === scopeIndex
    ) {
      stack.pop();
    }
    // Clean up empty entries
    if (stack.length === 0) {
      ctx.state.localVarStack.delete(name);
    }
  }
}
