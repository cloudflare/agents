import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const historyHelp = {
  name: "history",
  summary: "display command history",
  usage: "history [n]",
  options: [
    "-c      clear the history list",
    "    --help display this help and exit"
  ]
};

// History is stored in the environment as JSON
const HISTORY_KEY = "BASH_HISTORY";

export const historyCommand: Command = {
  name: "history",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(historyHelp);
    }

    // Get history from environment
    const historyStr = ctx.env.get(HISTORY_KEY) || "[]";
    let history: string[];
    try {
      history = JSON.parse(historyStr);
    } catch {
      history = [];
    }

    // Handle -c (clear)
    if (args[0] === "-c") {
      ctx.env.set(HISTORY_KEY, "[]");
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Get optional count
    let count = history.length;
    if (args[0] && /^\d+$/.test(args[0])) {
      count = Math.min(parseInt(args[0], 10), history.length);
    }

    // Display history
    const start = history.length - count;
    let stdout = "";
    for (let i = start; i < history.length; i++) {
      const lineNum = (i + 1).toString().padStart(5, " ");
      stdout += `${lineNum}  ${history[i]}\n`;
    }

    return { stdout, stderr: "", exitCode: 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "history",
  flags: [{ flag: "-c", type: "boolean" }]
};
