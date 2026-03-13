/**
 * exit - Exit shell builtin
 */

import { ExitError } from "../errors";
import type { InterpreterContext } from "../types";

export function handleExit(ctx: InterpreterContext, args: string[]): never {
  let exitCode: number;
  let stderr = "";

  if (args.length === 0) {
    // Use last command's exit code when no argument given
    exitCode = ctx.state.lastExitCode;
  } else {
    const arg = args[0];
    const parsed = Number.parseInt(arg, 10);
    // Empty string or non-numeric is an error
    if (arg === "" || Number.isNaN(parsed) || !/^-?\d+$/.test(arg)) {
      stderr = `bash: exit: ${arg}: numeric argument required\n`;
      exitCode = 2;
    } else {
      // Exit codes are modulo 256 (wrap around)
      exitCode = ((parsed % 256) + 256) % 256;
    }
  }

  throw new ExitError(exitCode, "", stderr);
}
