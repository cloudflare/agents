import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const pasteHelp = {
  name: "paste",
  summary: "merge lines of files",
  usage: "paste [OPTION]... [FILE]...",
  description: [
    "Write lines consisting of the sequentially corresponding lines from",
    "each FILE, separated by TABs, to standard output.",
    "",
    "With no FILE, or when FILE is -, read standard input."
  ],
  options: [
    "-d, --delimiters=LIST   reuse characters from LIST instead of TABs",
    "-s, --serial            paste one file at a time instead of in parallel",
    "    --help              display this help and exit"
  ],
  examples: [
    "paste file1 file2       Merge file1 and file2 side by side",
    "paste -d, file1 file2   Use comma as delimiter",
    "paste -s file1          Paste all lines of file1 on one line",
    "paste - - < file        Paste pairs of lines from file"
  ]
};

const argDefs = {
  delimiter: {
    short: "d",
    long: "delimiters",
    type: "string" as const,
    default: "\t"
  },
  serial: { short: "s", long: "serial", type: "boolean" as const }
};

export const pasteCommand: Command = {
  name: "paste",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(pasteHelp);
    }

    const parsed = parseArgs("paste", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const delimiter = parsed.result.flags.delimiter;
    const serial = parsed.result.flags.serial;
    const files = parsed.result.positional;

    // If no files specified, show usage error (matches BSD/macOS behavior)
    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "usage: paste [-s] [-d delimiters] file ...\n",
        exitCode: 1
      };
    }

    // Parse stdin into lines (will be distributed across multiple `-` args)
    const stdinLines = ctx.stdin ? ctx.stdin.split("\n") : [""];
    if (stdinLines.length > 0 && stdinLines[stdinLines.length - 1] === "") {
      stdinLines.pop();
    }

    // Count how many stdin ("-") arguments we have
    const stdinCount = files.filter((f) => f === "-").length;

    // Read all file contents
    // For stdin entries, we'll distribute lines across them
    const fileContents: (string[] | null)[] = [];
    let stdinIndex = 0;

    for (const file of files) {
      if (file === "-") {
        // This stdin gets every Nth line where N = stdinCount
        const thisStdinLines: string[] = [];
        for (let i = stdinIndex; i < stdinLines.length; i += stdinCount) {
          thisStdinLines.push(stdinLines[i]);
        }
        fileContents.push(thisStdinLines);
        stdinIndex++;
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          const content = await ctx.fs.readFile(filePath);
          const lines = content.split("\n");
          // Remove trailing empty line if content ends with newline
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          fileContents.push(lines);
        } catch {
          return {
            stdout: "",
            stderr: `paste: ${file}: No such file or directory\n`,
            exitCode: 1
          };
        }
      }
    }

    let output = "";

    if (serial) {
      // Serial mode: paste all lines of each file on one line
      for (const lines of fileContents) {
        if (lines) {
          output += `${joinWithDelimiters(lines, delimiter)}\n`;
        }
      }
    } else {
      // Parallel mode: merge lines from all files
      const maxLines = Math.max(...fileContents.map((f) => f?.length ?? 0));

      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        const lineParts: string[] = [];
        for (const lines of fileContents) {
          lineParts.push(lines?.[lineIdx] ?? "");
        }
        output += `${joinWithDelimiters(lineParts, delimiter)}\n`;
      }
    }

    return { stdout: output, stderr: "", exitCode: 0 };
  }
};

/**
 * Join parts using delimiters from the delimiter list.
 * Delimiters are used cyclically (e.g., with -d',;' first delimiter is ',', second is ';', then ',' again)
 */
function joinWithDelimiters(parts: string[], delimiters: string): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];

  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    // Use delimiter cyclically
    const delimIdx = (i - 1) % delimiters.length;
    result += delimiters[delimIdx] + parts[i];
  }
  return result;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "paste",
  flags: [
    { flag: "-d", type: "value", valueHint: "delimiter" },
    { flag: "-s", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
