import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const whichHelp = {
  name: "which",
  summary: "locate a command",
  usage: "which [-as] program ...",
  options: [
    "-a         List all instances of executables found",
    "-s         No output, just return 0 if found, 1 if not",
    "--help     display this help and exit"
  ]
};

const argDefs = {
  showAll: { short: "a", type: "boolean" as const },
  silent: { short: "s", type: "boolean" as const }
};

export const whichCommand: Command = {
  name: "which",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(whichHelp);
    }

    const parsed = parseArgs("which", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const showAll = parsed.result.flags.showAll;
    const silent = parsed.result.flags.silent;
    const names = parsed.result.positional;

    if (names.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    const pathEnv = ctx.env.get("PATH") || "/usr/bin:/bin";
    const pathDirs = pathEnv.split(":");

    let stdout = "";
    let allFound = true;

    for (const name of names) {
      let found = false;

      for (const dir of pathDirs) {
        if (!dir) continue;
        const fullPath = ctx.fs.resolvePath(dir, name);
        if (await ctx.fs.exists(fullPath)) {
          found = true;
          if (!silent) {
            stdout += `${fullPath}\n`;
          }
          if (!showAll) {
            break;
          }
        }
      }

      if (!found) {
        allFound = false;
      }
    }

    return {
      stdout,
      stderr: "",
      exitCode: allFound ? 0 : 1
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "which",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-s", type: "boolean" }
  ],
  needsArgs: true
};
