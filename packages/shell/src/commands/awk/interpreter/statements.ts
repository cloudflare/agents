/**
 * AWK Statement Execution
 *
 * Async statement executor supporting file I/O operations.
 */

import { ExecutionLimitError } from "../../../interpreter/errors";
import type { AwkArrayAccess, AwkExpr, AwkStmt, AwkVariable } from "../ast";
import { formatPrintf } from "../builtins";
import type { AwkRuntimeContext } from "./context";
import { evalExpr, setBlockExecutor } from "./expressions";
import { isTruthy, toAwkString, toNumber } from "./type-coercion";
import { deleteArray, deleteArrayElement } from "./variables";

// Register the block executor with expressions module (for user function calls)
setBlockExecutor(executeBlock);

/**
 * Check if AWK output buffer has exceeded the maximum size.
 * Throws ExecutionLimitError if the limit is set and exceeded.
 */
function checkAwkOutputSize(ctx: AwkRuntimeContext): void {
  if (ctx.maxOutputSize > 0 && ctx.output.length > ctx.maxOutputSize) {
    throw new ExecutionLimitError(
      `awk: output size limit exceeded (${ctx.maxOutputSize} bytes)`,
      "string_length",
      ctx.output
    );
  }
}

function assertAwkDefenseContext(
  _ctx: AwkRuntimeContext,
  _phase: string
): void {
  // no-op
}

function withDefenseContext<T>(
  _ctx: AwkRuntimeContext,
  _phase: string,
  op: () => Promise<T>
): Promise<T> {
  return op();
}

/**
 * Execute a block of statements.
 */
export async function executeBlock(
  ctx: AwkRuntimeContext,
  statements: AwkStmt[]
): Promise<void> {
  assertAwkDefenseContext(ctx, "block execution");
  for (const stmt of statements) {
    await withDefenseContext(ctx, "statement execution", () =>
      executeStmt(ctx, stmt)
    );
    if (shouldBreakExecution(ctx)) {
      break;
    }
  }
}

/**
 * Check if execution should break out of current block.
 */
function shouldBreakExecution(ctx: AwkRuntimeContext): boolean {
  return (
    ctx.shouldExit ||
    ctx.shouldNext ||
    ctx.shouldNextFile ||
    ctx.loopBreak ||
    ctx.loopContinue ||
    ctx.hasReturn
  );
}

/**
 * Execute a single statement.
 */
async function executeStmt(
  ctx: AwkRuntimeContext,
  stmt: AwkStmt
): Promise<void> {
  assertAwkDefenseContext(ctx, "single statement execution");
  switch (stmt.type) {
    case "block":
      await withDefenseContext(ctx, "nested block statement", () =>
        executeBlock(ctx, stmt.statements)
      );
      break;

    case "expr_stmt":
      await withDefenseContext(ctx, "expression statement", () =>
        evalExpr(ctx, stmt.expression)
      );
      break;

    case "print":
      await withDefenseContext(ctx, "print statement", () =>
        executePrint(ctx, stmt.args, stmt.output)
      );
      break;

    case "printf":
      await withDefenseContext(ctx, "printf statement", () =>
        executePrintf(ctx, stmt.format, stmt.args, stmt.output)
      );
      break;

    case "if":
      await withDefenseContext(ctx, "if statement", () => executeIf(ctx, stmt));
      break;

    case "while":
      await withDefenseContext(ctx, "while statement", () =>
        executeWhile(ctx, stmt)
      );
      break;

    case "do_while":
      await withDefenseContext(ctx, "do-while statement", () =>
        executeDoWhile(ctx, stmt)
      );
      break;

    case "for":
      await withDefenseContext(ctx, "for statement", () =>
        executeFor(ctx, stmt)
      );
      break;

    case "for_in":
      await withDefenseContext(ctx, "for-in statement", () =>
        executeForIn(ctx, stmt)
      );
      break;

    case "break":
      ctx.loopBreak = true;
      break;

    case "continue":
      ctx.loopContinue = true;
      break;

    case "next":
      ctx.shouldNext = true;
      break;

    case "nextfile":
      ctx.shouldNextFile = true;
      break;

    case "exit":
      ctx.shouldExit = true;
      {
        const codeExpr = stmt.code;
        ctx.exitCode = codeExpr
          ? Math.floor(
              toNumber(
                await withDefenseContext(ctx, "exit code expression", () =>
                  evalExpr(ctx, codeExpr)
                )
              )
            )
          : 0;
      }
      break;

    case "return":
      ctx.hasReturn = true;
      {
        const returnExpr = stmt.value;
        ctx.returnValue = returnExpr
          ? await withDefenseContext(ctx, "return expression", () =>
              evalExpr(ctx, returnExpr)
            )
          : "";
      }
      break;

    case "delete":
      await withDefenseContext(ctx, "delete statement", () =>
        executeDelete(ctx, stmt.target)
      );
      break;
  }
}

/**
 * Execute print statement with optional file redirection.
 * Numbers are formatted using OFMT (default "%.6g").
 */
async function executePrint(
  ctx: AwkRuntimeContext,
  args: AwkExpr[],
  output?: { redirect: ">" | ">>"; file: AwkExpr }
): Promise<void> {
  assertAwkDefenseContext(ctx, "print execution");
  const values: string[] = [];
  for (const arg of args) {
    const val = await withDefenseContext(ctx, "print argument evaluation", () =>
      evalExpr(ctx, arg)
    );
    // Use OFMT for numeric values (POSIX AWK behavior)
    // Exception: integers are printed directly without OFMT formatting
    // This matches real AWK behavior where `print 2292437248` outputs
    // the full integer, not scientific notation
    if (typeof val === "number") {
      if (Number.isInteger(val) && Math.abs(val) < Number.MAX_SAFE_INTEGER) {
        values.push(String(val));
      } else {
        values.push(formatPrintf(ctx.OFMT, [val]));
      }
    } else {
      values.push(toAwkString(val));
    }
  }
  const text = values.join(ctx.OFS) + ctx.ORS;

  if (output) {
    await withDefenseContext(ctx, "print redirection write", () =>
      writeToFile(ctx, output.redirect, output.file, text)
    );
  } else {
    ctx.output += text;
    checkAwkOutputSize(ctx);
  }
}

/**
 * Execute printf statement with optional file redirection.
 */
async function executePrintf(
  ctx: AwkRuntimeContext,
  format: AwkExpr,
  args: AwkExpr[],
  output?: { redirect: ">" | ">>"; file: AwkExpr }
): Promise<void> {
  assertAwkDefenseContext(ctx, "printf execution");
  const formatStr = toAwkString(
    await withDefenseContext(ctx, "printf format evaluation", () =>
      evalExpr(ctx, format)
    )
  );
  const values: (string | number)[] = [];
  for (const arg of args) {
    values.push(
      await withDefenseContext(ctx, "printf argument evaluation", () =>
        evalExpr(ctx, arg)
      )
    );
  }
  // DEBUG: console.log("printf DEBUG:", JSON.stringify({formatStr, values}));
  const text = formatPrintf(formatStr, values);

  if (output) {
    await withDefenseContext(ctx, "printf redirection write", () =>
      writeToFile(ctx, output.redirect, output.file, text)
    );
  } else {
    ctx.output += text;
    checkAwkOutputSize(ctx);
  }
}

/**
 * Write text to a file.
 */
async function writeToFile(
  ctx: AwkRuntimeContext,
  redirect: ">" | ">>",
  fileExpr: AwkExpr,
  text: string
): Promise<void> {
  assertAwkDefenseContext(ctx, "file write execution");
  const fs = ctx.fs;
  if (!fs || !ctx.cwd) {
    // No filesystem access - just append to output
    ctx.output += text;
    checkAwkOutputSize(ctx);
    return;
  }

  const filename = toAwkString(
    await withDefenseContext(ctx, "redirection filename evaluation", () =>
      evalExpr(ctx, fileExpr)
    )
  );
  const filePath = fs.resolvePath(ctx.cwd, filename);

  if (redirect === ">") {
    // Overwrite mode: first write clears file, subsequent writes append
    if (!ctx.openedFiles.has(filePath)) {
      // First write - overwrite (write empty first, then append)
      await withDefenseContext(ctx, "redirection overwrite write", () =>
        fs.writeFile(filePath, text)
      );
      ctx.openedFiles.add(filePath);
    } else {
      // Subsequent write - append
      await withDefenseContext(ctx, "redirection append write", () =>
        fs.appendFile(filePath, text)
      );
    }
  } else {
    // Append mode: always append
    if (!ctx.openedFiles.has(filePath)) {
      // First time seeing this file in append mode
      ctx.openedFiles.add(filePath);
    }
    await withDefenseContext(ctx, "redirection append mode write", () =>
      fs.appendFile(filePath, text)
    );
  }
}

/**
 * Execute if statement.
 */
async function executeIf(
  ctx: AwkRuntimeContext,
  stmt: { condition: AwkExpr; consequent: AwkStmt; alternate?: AwkStmt }
): Promise<void> {
  assertAwkDefenseContext(ctx, "if execution");
  if (
    isTruthy(
      await withDefenseContext(ctx, "if condition evaluation", () =>
        evalExpr(ctx, stmt.condition)
      )
    )
  ) {
    await withDefenseContext(ctx, "if consequent execution", () =>
      executeStmt(ctx, stmt.consequent)
    );
  } else if (stmt.alternate) {
    const alternate = stmt.alternate;
    await withDefenseContext(ctx, "if alternate execution", () =>
      executeStmt(ctx, alternate)
    );
  }
}

/**
 * Execute while loop.
 */
async function executeWhile(
  ctx: AwkRuntimeContext,
  stmt: { condition: AwkExpr; body: AwkStmt }
): Promise<void> {
  assertAwkDefenseContext(ctx, "while execution");
  let iterations = 0;

  while (
    isTruthy(
      await withDefenseContext(ctx, "while condition evaluation", () =>
        evalExpr(ctx, stmt.condition)
      )
    )
  ) {
    iterations++;
    if (iterations > ctx.maxIterations) {
      throw new ExecutionLimitError(
        `awk: while loop exceeded maximum iterations (${ctx.maxIterations})`,
        "iterations",
        ctx.output
      );
    }

    ctx.loopContinue = false;
    await withDefenseContext(ctx, "while body execution", () =>
      executeStmt(ctx, stmt.body)
    );

    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
  }
}

/**
 * Execute do-while loop.
 */
async function executeDoWhile(
  ctx: AwkRuntimeContext,
  stmt: { body: AwkStmt; condition: AwkExpr }
): Promise<void> {
  assertAwkDefenseContext(ctx, "do-while execution");
  let iterations = 0;

  do {
    iterations++;
    if (iterations > ctx.maxIterations) {
      throw new ExecutionLimitError(
        `awk: do-while loop exceeded maximum iterations (${ctx.maxIterations})`,
        "iterations",
        ctx.output
      );
    }

    ctx.loopContinue = false;
    await withDefenseContext(ctx, "do-while body execution", () =>
      executeStmt(ctx, stmt.body)
    );

    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
  } while (
    isTruthy(
      await withDefenseContext(ctx, "do-while condition evaluation", () =>
        evalExpr(ctx, stmt.condition)
      )
    )
  );
}

/**
 * Execute for loop.
 */
async function executeFor(
  ctx: AwkRuntimeContext,
  stmt: {
    init?: AwkExpr;
    condition?: AwkExpr;
    update?: AwkExpr;
    body: AwkStmt;
  }
): Promise<void> {
  assertAwkDefenseContext(ctx, "for execution");
  const initExpr = stmt.init;
  const conditionExpr = stmt.condition;
  const updateExpr = stmt.update;

  if (initExpr) {
    await withDefenseContext(ctx, "for init evaluation", () =>
      evalExpr(ctx, initExpr)
    );
  }

  let iterations = 0;

  while (
    !conditionExpr ||
    isTruthy(
      await withDefenseContext(ctx, "for condition evaluation", () =>
        evalExpr(ctx, conditionExpr)
      )
    )
  ) {
    iterations++;
    if (iterations > ctx.maxIterations) {
      throw new ExecutionLimitError(
        `awk: for loop exceeded maximum iterations (${ctx.maxIterations})`,
        "iterations",
        ctx.output
      );
    }

    ctx.loopContinue = false;
    await withDefenseContext(ctx, "for body execution", () =>
      executeStmt(ctx, stmt.body)
    );

    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }

    if (updateExpr) {
      await withDefenseContext(ctx, "for update evaluation", () =>
        evalExpr(ctx, updateExpr)
      );
    }
  }
}

/**
 * Execute for-in loop (iterate over array keys).
 */
async function executeForIn(
  ctx: AwkRuntimeContext,
  stmt: { variable: string; array: string; body: AwkStmt }
): Promise<void> {
  assertAwkDefenseContext(ctx, "for-in execution");
  const array = ctx.arrays[stmt.array];
  if (!array) return;

  for (const key of Object.keys(array)) {
    ctx.vars[stmt.variable] = key;

    ctx.loopContinue = false;
    await withDefenseContext(ctx, "for-in body execution", () =>
      executeStmt(ctx, stmt.body)
    );

    if (ctx.loopBreak) {
      ctx.loopBreak = false;
      break;
    }
    if (ctx.shouldExit || ctx.shouldNext || ctx.hasReturn) {
      break;
    }
  }
}

/**
 * Execute delete statement.
 */
async function executeDelete(
  ctx: AwkRuntimeContext,
  target: AwkArrayAccess | AwkVariable
): Promise<void> {
  assertAwkDefenseContext(ctx, "delete execution");
  if (target.type === "array_access") {
    const key = toAwkString(
      await withDefenseContext(ctx, "delete key evaluation", () =>
        evalExpr(ctx, target.key)
      )
    );
    deleteArrayElement(ctx, target.array, key);
  } else if (target.type === "variable") {
    deleteArray(ctx, target.name);
  }
}
