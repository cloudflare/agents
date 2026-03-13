import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { readAndConcat } from "../../utils/file-reader";
import { hasHelpFlag, showHelp } from "../help";

const uniqHelp = {
  name: "uniq",
  summary: "report or omit repeated lines",
  usage: "uniq [OPTION]... [INPUT [OUTPUT]]",
  options: [
    "-c, --count        prefix lines by the number of occurrences",
    "-d, --repeated     only print duplicate lines",
    "-i, --ignore-case  ignore case when comparing",
    "-u, --unique       only print unique lines",
    "    --help         display this help and exit"
  ]
};

const argDefs = {
  count: { short: "c", long: "count", type: "boolean" as const },
  duplicatesOnly: { short: "d", long: "repeated", type: "boolean" as const },
  uniqueOnly: { short: "u", long: "unique", type: "boolean" as const },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const }
};

export const uniqCommand: Command = {
  name: "uniq",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(uniqHelp);
    }

    const parsed = parseArgs("uniq", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { count, duplicatesOnly, uniqueOnly, ignoreCase } =
      parsed.result.flags;
    const files = parsed.result.positional;

    // Read from files or stdin
    const readResult = await readAndConcat(ctx, files, { cmdName: "uniq" });
    if (!readResult.ok) return readResult.error;
    const content = readResult.content;

    // Split into lines
    const lines = content.split("\n");

    // Remove last empty element if content ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (lines.length === 0) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Process adjacent duplicates
    const result: Array<{ line: string; count: number }> = [];
    let currentLine = lines[0];
    let currentCount = 1;

    const compareLines = (a: string, b: string): boolean => {
      if (ignoreCase) {
        return a.toLowerCase() === b.toLowerCase();
      }
      return a === b;
    };

    for (let i = 1; i < lines.length; i++) {
      if (compareLines(lines[i], currentLine)) {
        currentCount++;
      } else {
        result.push({ line: currentLine, count: currentCount });
        currentLine = lines[i];
        currentCount = 1;
      }
    }
    result.push({ line: currentLine, count: currentCount });

    // Filter based on options
    let filtered = result;
    if (duplicatesOnly) {
      filtered = result.filter((r) => r.count > 1);
    } else if (uniqueOnly) {
      filtered = result.filter((r) => r.count === 1);
    }

    // Format output
    let output = "";
    for (const { line, count: c } of filtered) {
      if (count) {
        // Real bash right-justifies count in 4-char field followed by space
        output += `${String(c).padStart(4)} ${line}\n`;
      } else {
        output += `${line}\n`;
      }
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
      stdoutEncoding: "binary"
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "uniq",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-u", type: "boolean" },
    { flag: "-i", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
