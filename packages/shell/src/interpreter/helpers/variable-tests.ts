import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import { evaluateArithmetic } from "../arithmetic";
import type { InterpreterContext } from "../types";
import { getArrayIndices, getAssocArrayKeys } from "./array";

/**
 * Evaluates the -v (variable is set) test.
 * Handles both simple variables and array element access with negative indices.
 *
 * @param ctx - Interpreter context with environment variables
 * @param operand - The variable name to test, may include array subscript (e.g., "arr[0]", "arr[-1]")
 */
export async function evaluateVariableTest(
  ctx: InterpreterContext,
  operand: string
): Promise<boolean> {
  // Check for array element syntax: var[index]
  const arrayMatch = operand.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);

  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    const indexExpr = arrayMatch[2];

    // Check if this is an associative array
    const isAssoc = ctx.state.associativeArrays?.has(arrayName);

    if (isAssoc) {
      // For associative arrays, use the key as-is (strip quotes if present)
      let key = indexExpr;
      // Remove surrounding quotes if present
      if (
        (key.startsWith("'") && key.endsWith("'")) ||
        (key.startsWith('"') && key.endsWith('"'))
      ) {
        key = key.slice(1, -1);
      }
      // Expand variables in key
      key = key.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, varName) => {
        return ctx.state.env.get(varName) || "";
      });
      return ctx.state.env.has(`${arrayName}_${key}`);
    }

    // Evaluate as arithmetic expression (handles variables like zero+0)
    let index: number;
    try {
      const parser = new Parser();
      const arithAst = parseArithmeticExpression(parser, indexExpr);
      index = await evaluateArithmetic(ctx, arithAst.expression);
    } catch {
      // If parsing fails, try simple numeric
      if (/^-?\d+$/.test(indexExpr)) {
        index = Number.parseInt(indexExpr, 10);
      } else {
        // Last resort: try looking up as variable
        const varValue = ctx.state.env.get(indexExpr);
        index = varValue ? Number.parseInt(varValue, 10) : 0;
      }
    }

    // Handle negative indices - bash counts from max_index + 1
    if (index < 0) {
      const indices = getArrayIndices(ctx, arrayName);
      const lineNum = ctx.state.currentLine;
      if (indices.length === 0) {
        // Empty array with negative index - emit warning and return false
        ctx.state.expansionStderr =
          (ctx.state.expansionStderr || "") +
          `bash: line ${lineNum}: ${arrayName}: bad array subscript\n`;
        return false;
      }
      const maxIndex = Math.max(...indices);
      index = maxIndex + 1 + index;
      if (index < 0) {
        // Out of bounds negative index - emit warning and return false
        ctx.state.expansionStderr =
          (ctx.state.expansionStderr || "") +
          `bash: line ${lineNum}: ${arrayName}: bad array subscript\n`;
        return false;
      }
    }

    return ctx.state.env.has(`${arrayName}_${index}`);
  }

  // Check if it's a regular variable
  if (ctx.state.env.has(operand)) {
    return true;
  }

  // Check if it's an array with elements (test -v arrayname without subscript)
  // For associative arrays, check if there are any keys
  if (ctx.state.associativeArrays?.has(operand)) {
    return getAssocArrayKeys(ctx, operand).length > 0;
  }

  // For indexed arrays, check if there are any indices
  return getArrayIndices(ctx, operand).length > 0;
}
