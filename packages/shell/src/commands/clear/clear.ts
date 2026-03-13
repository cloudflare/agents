import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const clearHelp = {
  name: "clear",
  summary: "clear the terminal screen",
  usage: "clear [OPTIONS]",
  options: ["    --help display this help and exit"]
};

export const clearCommand: Command = {
  name: "clear",

  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(clearHelp);
    }

    // ANSI escape sequence to clear screen and move cursor to top-left
    const clearSequence = "\x1B[2J\x1B[H";

    return { stdout: clearSequence, stderr: "", exitCode: 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "clear",
  flags: []
};
