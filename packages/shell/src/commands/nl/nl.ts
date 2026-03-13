/**
 * nl - number lines of files
 *
 * Usage: nl [OPTION]... [FILE]...
 *
 * Write each FILE to standard output, with line numbers added.
 * If no FILE is specified, standard input is read.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const nlHelp = {
  name: "nl",
  summary: "number lines of files",
  usage: "nl [OPTION]... [FILE]...",
  description:
    "Write each FILE to standard output, with line numbers added. If no FILE is specified, standard input is read.",
  options: [
    "-b STYLE     Body numbering style: a (all), t (non-empty), n (none)",
    "-n FORMAT    Number format: ln (left), rn (right), rz (right zeros)",
    "-w WIDTH     Number width (default: 6)",
    "-s SEP       Separator after number (default: TAB)",
    "-v START     Starting line number (default: 1)",
    "-i INCR      Line number increment (default: 1)"
  ],
  examples: [
    "nl file.txt              # Number non-empty lines",
    "nl -ba file.txt          # Number all lines",
    "nl -n rz -w 3 file.txt   # Right-justified with zeros",
    "nl -s ': ' file.txt      # Use ': ' as separator"
  ]
};

type NumberingStyle = "a" | "t" | "n";
type NumberFormat = "ln" | "rn" | "rz";

interface NlOptions {
  bodyStyle: NumberingStyle;
  numberFormat: NumberFormat;
  width: number;
  separator: string;
  startNumber: number;
  increment: number;
}

function formatLineNumber(
  num: number,
  format: NumberFormat,
  width: number
): string {
  const numStr = String(num);
  switch (format) {
    case "ln":
      // Left justified
      return numStr.padEnd(width);
    case "rn":
      // Right justified with spaces
      return numStr.padStart(width);
    case "rz":
      // Right justified with zeros
      return numStr.padStart(width, "0");
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

function shouldNumber(line: string, style: NumberingStyle): boolean {
  switch (style) {
    case "a":
      return true;
    case "t":
      return line.trim().length > 0;
    case "n":
      return false;
    default: {
      const _exhaustive: never = style;
      return _exhaustive;
    }
  }
}

function processContent(
  content: string,
  options: NlOptions,
  currentNumber: number
): { output: string; nextNumber: number } {
  // Handle empty input
  if (content === "") {
    return { output: "", nextNumber: currentNumber };
  }

  const lines = content.split("\n");
  const resultLines: string[] = [];
  let lineNumber = currentNumber;

  // Handle trailing newline
  const hasTrailingNewline =
    content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }

  for (const line of lines) {
    if (shouldNumber(line, options.bodyStyle)) {
      const formattedNum = formatLineNumber(
        lineNumber,
        options.numberFormat,
        options.width
      );
      resultLines.push(`${formattedNum}${options.separator}${line}`);
      lineNumber += options.increment;
    } else {
      // Empty line without numbering - just add padding spaces for alignment
      const padding = " ".repeat(options.width);
      resultLines.push(`${padding}${options.separator}${line}`);
    }
  }

  return {
    output: resultLines.join("\n") + (hasTrailingNewline ? "\n" : ""),
    nextNumber: lineNumber
  };
}

export const nl: Command = {
  name: "nl",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(nlHelp);
    }

    const options: NlOptions = {
      bodyStyle: "t",
      numberFormat: "rn",
      width: 6,
      separator: "\t",
      startNumber: 1,
      increment: 1
    };

    const files: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      if (arg === "-b" && i + 1 < args.length) {
        const style = args[i + 1];
        if (style !== "a" && style !== "t" && style !== "n") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid body numbering style: '${style}'\n`
          };
        }
        options.bodyStyle = style;
        i += 2;
      } else if (arg.startsWith("-b")) {
        const style = arg.slice(2);
        if (style !== "a" && style !== "t" && style !== "n") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid body numbering style: '${style}'\n`
          };
        }
        options.bodyStyle = style;
        i++;
      } else if (arg === "-n" && i + 1 < args.length) {
        const format = args[i + 1];
        if (format !== "ln" && format !== "rn" && format !== "rz") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line numbering format: '${format}'\n`
          };
        }
        options.numberFormat = format;
        i += 2;
      } else if (arg.startsWith("-n")) {
        const format = arg.slice(2);
        if (format !== "ln" && format !== "rn" && format !== "rz") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line numbering format: '${format}'\n`
          };
        }
        options.numberFormat = format;
        i++;
      } else if (arg === "-w" && i + 1 < args.length) {
        const width = parseInt(args[i + 1], 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number field width: '${args[i + 1]}'\n`
          };
        }
        options.width = width;
        i += 2;
      } else if (arg.startsWith("-w")) {
        const width = parseInt(arg.slice(2), 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number field width: '${arg.slice(2)}'\n`
          };
        }
        options.width = width;
        i++;
      } else if (arg === "-s" && i + 1 < args.length) {
        options.separator = args[i + 1];
        i += 2;
      } else if (arg.startsWith("-s")) {
        options.separator = arg.slice(2);
        i++;
      } else if (arg === "-v" && i + 1 < args.length) {
        const start = parseInt(args[i + 1], 10);
        if (Number.isNaN(start)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid starting line number: '${args[i + 1]}'\n`
          };
        }
        options.startNumber = start;
        i += 2;
      } else if (arg.startsWith("-v")) {
        const start = parseInt(arg.slice(2), 10);
        if (Number.isNaN(start)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid starting line number: '${arg.slice(2)}'\n`
          };
        }
        options.startNumber = start;
        i++;
      } else if (arg === "-i" && i + 1 < args.length) {
        const incr = parseInt(args[i + 1], 10);
        if (Number.isNaN(incr)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number increment: '${args[i + 1]}'\n`
          };
        }
        options.increment = incr;
        i += 2;
      } else if (arg.startsWith("-i")) {
        const incr = parseInt(arg.slice(2), 10);
        if (Number.isNaN(incr)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `nl: invalid line number increment: '${arg.slice(2)}'\n`
          };
        }
        options.increment = incr;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("nl", arg);
      } else {
        files.push(arg);
        i++;
      }
    }

    let output = "";
    let lineNumber = options.startNumber;

    if (files.length === 0) {
      // Read from stdin
      const input = ctx.stdin ?? "";
      const result = processContent(input, options, lineNumber);
      output = result.output;
    } else {
      // Process each file
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: output,
            stderr: `nl: ${file}: No such file or directory\n`
          };
        }
        const result = processContent(content, options, lineNumber);
        output += result.output;
        lineNumber = result.nextNumber;
      }
    }

    return {
      exitCode: 0,
      stdout: output,
      stderr: ""
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "nl",
  flags: [
    { flag: "-b", type: "value", valueHint: "string" },
    { flag: "-n", type: "value", valueHint: "string" },
    { flag: "-w", type: "value", valueHint: "number" },
    { flag: "-s", type: "value", valueHint: "string" },
    { flag: "-v", type: "value", valueHint: "number" },
    { flag: "-i", type: "value", valueHint: "number" }
  ],
  stdinType: "text",
  needsFiles: true
};
