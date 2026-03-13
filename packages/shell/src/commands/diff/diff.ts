/**
 * diff - Compare files line by line
 */

import * as Diff from "diff";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILE1 FILE2",
  options: [
    "-u, --unified     output unified diff format (default)",
    "-q, --brief       report only whether files differ",
    "-s, --report-identical-files  report when files are the same",
    "-i, --ignore-case  ignore case differences",
    "    --help        display this help and exit"
  ]
};

const argDefs = {
  unified: { short: "u", long: "unified", type: "boolean" as const },
  brief: { short: "q", long: "brief", type: "boolean" as const },
  reportSame: {
    short: "s",
    long: "report-identical-files",
    type: "boolean" as const
  },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const }
};

export const diffCommand: Command = {
  name: "diff",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(diffHelp);

    const parsed = parseArgs("diff", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const brief = parsed.result.flags.brief;
    const reportSame = parsed.result.flags.reportSame;
    const ignoreCase = parsed.result.flags.ignoreCase;
    const files = parsed.result.positional;

    // Note: unified flag is accepted but is the default behavior
    void parsed.result.flags.unified;

    if (files.length < 2) {
      return { stdout: "", stderr: "diff: missing operand\n", exitCode: 2 };
    }

    let c1: string, c2: string;
    const [f1, f2] = files;

    try {
      c1 =
        f1 === "-"
          ? ctx.stdin
          : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f1));
    } catch {
      return {
        stdout: "",
        stderr: `diff: ${f1}: No such file or directory\n`,
        exitCode: 2
      };
    }

    try {
      c2 =
        f2 === "-"
          ? ctx.stdin
          : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f2));
    } catch {
      return {
        stdout: "",
        stderr: `diff: ${f2}: No such file or directory\n`,
        exitCode: 2
      };
    }

    let t1 = c1,
      t2 = c2;
    if (ignoreCase) {
      t1 = t1.toLowerCase();
      t2 = t2.toLowerCase();
    }

    if (t1 === t2) {
      if (reportSame)
        return {
          stdout: `Files ${f1} and ${f2} are identical\n`,
          stderr: "",
          exitCode: 0
        };
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (brief) {
      return {
        stdout: `Files ${f1} and ${f2} differ\n`,
        stderr: "",
        exitCode: 1
      };
    }

    const output = Diff.createTwoFilesPatch(f1, f2, c1, c2, "", "", {
      context: 3
    });
    return { stdout: output, stderr: "", exitCode: 1 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "diff",
  flags: [
    { flag: "-u", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-i", type: "boolean" }
  ],
  needsArgs: true,
  minArgs: 2
};
