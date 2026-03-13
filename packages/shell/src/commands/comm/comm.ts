/**
 * comm - compare two sorted files line by line
 *
 * Outputs three columns:
 * - Column 1: lines only in FILE1
 * - Column 2: lines only in FILE2
 * - Column 3: lines in both files
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const commHelp = {
  name: "comm",
  summary: "compare two sorted files line by line",
  usage: "comm [OPTION]... FILE1 FILE2",
  options: [
    "-1             suppress column 1 (lines unique to FILE1)",
    "-2             suppress column 2 (lines unique to FILE2)",
    "-3             suppress column 3 (lines that appear in both files)",
    "    --help     display this help and exit"
  ]
};

export const commCommand: Command = {
  name: "comm",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(commHelp);

    let suppress1 = false;
    let suppress2 = false;
    let suppress3 = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === "-1") suppress1 = true;
      else if (arg === "-2") suppress2 = true;
      else if (arg === "-3") suppress3 = true;
      else if (arg === "-12" || arg === "-21") {
        suppress1 = true;
        suppress2 = true;
      } else if (arg === "-13" || arg === "-31") {
        suppress1 = true;
        suppress3 = true;
      } else if (arg === "-23" || arg === "-32") {
        suppress2 = true;
        suppress3 = true;
      } else if (
        arg === "-123" ||
        arg === "-132" ||
        arg === "-213" ||
        arg === "-231" ||
        arg === "-312" ||
        arg === "-321"
      ) {
        suppress1 = true;
        suppress2 = true;
        suppress3 = true;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("comm", arg);
      } else {
        files.push(arg);
      }
    }

    if (files.length !== 2) {
      return {
        stdout: "",
        stderr:
          "comm: missing operand\nTry 'comm --help' for more information.\n",
        exitCode: 1
      };
    }

    // Read file contents
    const readFile = async (file: string): Promise<string | null> => {
      if (file === "-") {
        return ctx.stdin;
      }
      try {
        const path = ctx.fs.resolvePath(ctx.cwd, file);
        return await ctx.fs.readFile(path);
      } catch {
        return null;
      }
    };

    const content1 = await readFile(files[0]);
    if (content1 === null) {
      return {
        stdout: "",
        stderr: `comm: ${files[0]}: No such file or directory\n`,
        exitCode: 1
      };
    }

    const content2 = await readFile(files[1]);
    if (content2 === null) {
      return {
        stdout: "",
        stderr: `comm: ${files[1]}: No such file or directory\n`,
        exitCode: 1
      };
    }

    // Split into lines
    const lines1 = content1.split("\n");
    const lines2 = content2.split("\n");

    // Remove trailing empty line if present (from trailing newline)
    if (lines1.length > 0 && lines1[lines1.length - 1] === "") lines1.pop();
    if (lines2.length > 0 && lines2[lines2.length - 1] === "") lines2.pop();

    // Merge algorithm for sorted files
    let i = 0;
    let j = 0;
    let output = "";

    // Calculate tab prefixes based on suppressed columns
    const col2Prefix = suppress1 ? "" : "\t";
    const col3Prefix = (suppress1 ? "" : "\t") + (suppress2 ? "" : "\t");

    while (i < lines1.length || j < lines2.length) {
      if (i >= lines1.length) {
        // Only file2 lines remain
        if (!suppress2) {
          output += `${col2Prefix}${lines2[j]}\n`;
        }
        j++;
      } else if (j >= lines2.length) {
        // Only file1 lines remain
        if (!suppress1) {
          output += `${lines1[i]}\n`;
        }
        i++;
      } else if (lines1[i] < lines2[j]) {
        // Line only in file1
        if (!suppress1) {
          output += `${lines1[i]}\n`;
        }
        i++;
      } else if (lines1[i] > lines2[j]) {
        // Line only in file2
        if (!suppress2) {
          output += `${col2Prefix}${lines2[j]}\n`;
        }
        j++;
      } else {
        // Line in both files
        if (!suppress3) {
          output += `${col3Prefix}${lines1[i]}\n`;
        }
        i++;
        j++;
      }
    }

    return { stdout: output, stderr: "", exitCode: 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "comm",
  flags: [
    { flag: "-1", type: "boolean" },
    { flag: "-2", type: "boolean" },
    { flag: "-3", type: "boolean" }
  ],
  needsArgs: true,
  minArgs: 2
};
