/**
 * let - Evaluate arithmetic expressions
 *
 * Usage:
 *   let expr [expr ...]
 *   let "x=1" "y=x+2"
 *
 * Each argument is evaluated as an arithmetic expression.
 * Returns 0 if the last expression evaluates to non-zero,
 * returns 1 if it evaluates to zero.
 *
 * Note: In bash, `let x=( 1 )` passes separate args ["x=(", "1", ")"]
 * when not quoted. The let builtin needs to handle this by joining
 * arguments that are part of the same expression.
 */

import type { ArithmeticCommandNode } from "../../ast/types";
import { parse } from "../../parser/parser";
import type { ExecResult } from "../../types";
import { evaluateArithmetic } from "../arithmetic";
import { failure, result } from "../helpers/result";
import type { InterpreterContext } from "../types";

/**
 * Parse arguments into expressions.
 * Handles cases like `let x=( 1 )` where parentheses cause splitting.
 */
function parseLetArgs(args: string[]): string[] {
  const expressions: string[] = [];
  let current = "";
  let parenDepth = 0;

  for (const arg of args) {
    // Count open and close parens in this arg
    for (const ch of arg) {
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
    }

    if (current) {
      current += ` ${arg}`;
    } else {
      current = arg;
    }

    // If parens are balanced, this is a complete expression
    if (parenDepth === 0) {
      expressions.push(current);
      current = "";
    }
  }

  // Handle any remaining (unbalanced parens treated as single expression)
  if (current) {
    expressions.push(current);
  }

  return expressions;
}

export async function handleLet(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  if (args.length === 0) {
    return failure("bash: let: expression expected\n");
  }

  // Parse args into expressions (handling split parentheses)
  const expressions = parseLetArgs(args);
  let lastResult = 0;

  for (const expr of expressions) {
    try {
      // Parse the expression by wrapping it in (( ))
      // This leverages the existing arithmetic parser
      const script = parse(`(( ${expr} ))`);

      // Navigate through the AST: Script -> Statement -> Pipeline -> Command
      const statement = script.statements[0];
      if (
        statement &&
        statement.pipelines.length > 0 &&
        statement.pipelines[0].commands.length > 0
      ) {
        const command = statement.pipelines[0].commands[0];
        if (command.type === "ArithmeticCommand") {
          const arithNode = command as ArithmeticCommandNode;
          lastResult = await evaluateArithmetic(
            ctx,
            arithNode.expression.expression
          );
        }
      }
    } catch (error) {
      return failure(`bash: let: ${expr}: ${(error as Error).message}\n`);
    }
  }

  // Return 0 if last expression is non-zero, 1 if zero
  return result("", "", lastResult === 0 ? 1 : 0);
}
