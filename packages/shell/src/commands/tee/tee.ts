import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const teeHelp = {
  name: "tee",
  summary: "read from stdin and write to stdout and files",
  usage: "tee [OPTION]... [FILE]...",
  options: [
    "-a, --append     append to the given FILEs, do not overwrite",
    "    --help       display this help and exit"
  ]
};

const argDefs = {
  append: { short: "a", long: "append", type: "boolean" as const }
};

export const teeCommand: Command = {
  name: "tee",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(teeHelp);
    }

    const parsed = parseArgs("tee", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { append } = parsed.result.flags;
    const files = parsed.result.positional;
    const content = ctx.stdin;
    let stderr = "";
    let exitCode = 0;

    // Write to each file
    for (const file of files) {
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        if (append) {
          await ctx.fs.appendFile(filePath, content);
        } else {
          await ctx.fs.writeFile(filePath, content);
        }
      } catch (_error) {
        stderr += `tee: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    // Pass through to stdout
    return {
      stdout: content,
      stderr,
      exitCode
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tee",
  flags: [{ flag: "-a", type: "boolean" }],
  stdinType: "text",
  needsArgs: true
};
