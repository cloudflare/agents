import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const dirnameHelp = {
  name: "dirname",
  summary: "strip last component from file name",
  usage: "dirname [OPTION] NAME...",
  options: ["    --help       display this help and exit"]
};

export const dirnameCommand: Command = {
  name: "dirname",

  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(dirnameHelp);
    }

    const names = args.filter((arg) => !arg.startsWith("-"));

    if (names.length === 0) {
      return {
        stdout: "",
        stderr: "dirname: missing operand\n",
        exitCode: 1
      };
    }

    const results: string[] = [];
    for (const name of names) {
      // Remove trailing slashes
      const cleanName = name.replace(/\/+$/, "");
      const lastSlash = cleanName.lastIndexOf("/");
      if (lastSlash === -1) {
        results.push(".");
      } else if (lastSlash === 0) {
        results.push("/");
      } else {
        results.push(cleanName.slice(0, lastSlash));
      }
    }

    return {
      stdout: `${results.join("\n")}\n`,
      stderr: "",
      exitCode: 0
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "dirname",
  flags: [],
  needsArgs: true
};
