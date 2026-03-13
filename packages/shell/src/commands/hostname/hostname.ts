/**
 * hostname - show or set the system's host name
 *
 * Usage: hostname [NAME]
 *
 * In sandboxed environment, always returns "localhost".
 */

import type { Command, CommandContext, ExecResult } from "../../types";

async function hostnameExecute(
  _args: string[],
  _ctx: CommandContext
): Promise<ExecResult> {
  // In sandboxed environment, always return "localhost"
  return { stdout: "localhost\n", stderr: "", exitCode: 0 };
}

export const hostname: Command = {
  name: "hostname",
  execute: hostnameExecute
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "hostname",
  flags: []
};
