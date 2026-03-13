/**
 * shift - Shift positional parameters
 *
 * shift [n]
 *
 * Shifts positional parameters to the left by n (default 1).
 * $n+1 becomes $1, $n+2 becomes $2, etc.
 * $# is decremented by n.
 *
 * In POSIX mode (set -o posix), errors from shift (like shift count
 * exceeding available parameters) cause the script to exit immediately.
 */

import type { ExecResult } from "../../types";
import { PosixFatalError } from "../errors";
import { failure, OK } from "../helpers/result";
import type { InterpreterContext } from "../types";

export function handleShift(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  // Default shift count is 1
  let n = 1;

  if (args.length > 0) {
    const parsed = Number.parseInt(args[0], 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      const errorMsg = `bash: shift: ${args[0]}: numeric argument required\n`;
      // In POSIX mode, this error is fatal
      if (ctx.state.options.posix) {
        throw new PosixFatalError(1, "", errorMsg);
      }
      return failure(errorMsg);
    }
    n = parsed;
  }

  // Get current positional parameter count
  const currentCount = Number.parseInt(ctx.state.env.get("#") || "0", 10);

  // Check if shift count exceeds available parameters
  if (n > currentCount) {
    const errorMsg = "bash: shift: shift count out of range\n";
    // In POSIX mode, this error is fatal
    if (ctx.state.options.posix) {
      throw new PosixFatalError(1, "", errorMsg);
    }
    return failure(errorMsg);
  }

  // If n is 0, do nothing
  if (n === 0) {
    return OK;
  }

  // Get current positional parameters
  const params: string[] = [];
  for (let i = 1; i <= currentCount; i++) {
    params.push(ctx.state.env.get(String(i)) || "");
  }

  // Remove first n parameters
  const newParams = params.slice(n);

  // Clear all old positional parameters
  for (let i = 1; i <= currentCount; i++) {
    ctx.state.env.delete(String(i));
  }

  // Set new positional parameters
  for (let i = 0; i < newParams.length; i++) {
    ctx.state.env.set(String(i + 1), newParams[i]);
  }

  // Update $# and $@
  ctx.state.env.set("#", String(newParams.length));
  ctx.state.env.set("@", newParams.join(" "));

  return OK;
}
