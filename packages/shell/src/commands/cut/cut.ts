import type { Command, CommandContext, ExecResult } from "../../types";
import { readAndConcat } from "../../utils/file-reader";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const cutHelp = {
  name: "cut",
  summary: "remove sections from each line of files",
  usage: "cut [OPTION]... [FILE]...",
  options: [
    "-c LIST              select only these characters",
    "-d DELIM             use DELIM instead of TAB for field delimiter",
    "-f LIST              select only these fields",
    "-s, --only-delimited  do not print lines without delimiters",
    "    --help           display this help and exit"
  ]
};

interface CutRange {
  start: number;
  end: number | null; // null means to end of line
}

function parseRange(spec: string): CutRange[] {
  const ranges: CutRange[] = [];
  const parts = spec.split(",");

  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-");
      ranges.push({
        start: start ? parseInt(start, 10) : 1,
        end: end ? parseInt(end, 10) : null
      });
    } else {
      const num = parseInt(part, 10);
      ranges.push({ start: num, end: num });
    }
  }

  return ranges;
}

function extractByRanges(items: string[], ranges: CutRange[]): string[] {
  const result: string[] = [];

  for (const range of ranges) {
    const start = range.start - 1; // Convert to 0-indexed
    const end = range.end === null ? items.length : range.end;

    for (let i = start; i < end && i < items.length; i++) {
      if (i >= 0 && !result.includes(items[i])) {
        result.push(items[i]);
      }
    }
  }

  return result;
}

export const cutCommand: Command = {
  name: "cut",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(cutHelp);
    }

    let delimiter = "\t";
    let fieldSpec: string | null = null;
    let charSpec: string | null = null;
    let suppressNoDelim = false;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-d") {
        delimiter = args[++i] || "\t";
      } else if (arg.startsWith("-d")) {
        delimiter = arg.slice(2);
      } else if (arg === "-f") {
        fieldSpec = args[++i];
      } else if (arg.startsWith("-f")) {
        fieldSpec = arg.slice(2);
      } else if (arg === "-c") {
        charSpec = args[++i];
      } else if (arg.startsWith("-c")) {
        charSpec = arg.slice(2);
      } else if (arg === "-s" || arg === "--only-delimited") {
        suppressNoDelim = true;
      } else if (arg.startsWith("--")) {
        return unknownOption("cut", arg);
      } else if (arg.startsWith("-")) {
        // Check for combined short options like -sf1
        let unknown = false;
        for (const c of arg.slice(1)) {
          if (c === "s") {
            suppressNoDelim = true;
          } else if (!"dfc".includes(c)) {
            unknown = true;
            break;
          }
        }
        if (unknown) {
          return unknownOption("cut", arg);
        }
      } else {
        files.push(arg);
      }
    }

    if (!fieldSpec && !charSpec) {
      return {
        stdout: "",
        stderr:
          "cut: you must specify a list of bytes, characters, or fields\n",
        exitCode: 1
      };
    }

    // Read from files or stdin
    const readResult = await readAndConcat(ctx, files, { cmdName: "cut" });
    if (!readResult.ok) return readResult.error;
    const content = readResult.content;

    // Split into lines
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const ranges = parseRange(fieldSpec || charSpec || "1");
    let output = "";

    for (const line of lines) {
      if (charSpec) {
        // Character mode (-s has no effect in character mode)
        const chars = line.split("");
        const selected: string[] = [];
        for (const range of ranges) {
          const start = range.start - 1;
          const end = range.end === null ? chars.length : range.end;
          for (let i = start; i < end && i < chars.length; i++) {
            if (i >= 0) {
              selected.push(chars[i]);
            }
          }
        }
        output += `${selected.join("")}\n`;
      } else {
        // Field mode
        // If -s is set, skip lines that don't contain the delimiter
        if (suppressNoDelim && !line.includes(delimiter)) {
          continue;
        }
        const fields = line.split(delimiter);
        const selected = extractByRanges(fields, ranges);
        output += `${selected.join(delimiter)}\n`;
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
  name: "cut",
  flags: [
    { flag: "-d", type: "value", valueHint: "delimiter" },
    { flag: "-f", type: "value", valueHint: "string" },
    { flag: "-c", type: "value", valueHint: "string" },
    { flag: "-s", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
