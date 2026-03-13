/**
 * Condition execution helper for the interpreter.
 *
 * Handles executing condition statements with proper inCondition state management.
 * Used by if, while, and until loops.
 */

import type { StatementNode } from "../../ast/types";
import type { InterpreterContext } from "../types";

export interface ConditionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute condition statements with inCondition flag set.
 * This prevents errexit from triggering during condition evaluation.
 *
 * @param ctx - Interpreter context
 * @param statements - Condition statements to execute
 * @returns Accumulated stdout, stderr, and final exit code
 */
export async function executeCondition(
  ctx: InterpreterContext,
  statements: StatementNode[]
): Promise<ConditionResult> {
  const savedInCondition = ctx.state.inCondition;
  ctx.state.inCondition = true;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    for (const stmt of statements) {
      const result = await ctx.executeStatement(stmt);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }
  } finally {
    ctx.state.inCondition = savedInCondition;
  }

  return { stdout, stderr, exitCode };
}
