/**
 * whoami - print effective user name
 *
 * Usage: whoami
 *
 * In sandboxed environment, always returns "user".
 */

import type { Command, CommandContext, ExecResult } from "../../types";

async function whoamiExecute(
  _args: string[],
  _ctx: CommandContext
): Promise<ExecResult> {
  // In sandboxed environment, always return "user"
  return { stdout: "user\n", stderr: "", exitCode: 0 };
}

export const whoami: Command = {
  name: "whoami",
  execute: whoamiExecute
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "whoami",
  flags: []
};
