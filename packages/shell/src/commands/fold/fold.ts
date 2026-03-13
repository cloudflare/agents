/**
 * fold - wrap each input line to fit in specified width
 *
 * Usage: fold [OPTION]... [FILE]...
 *
 * Wrap input lines in each FILE, writing to standard output.
 * If no FILE is specified, standard input is read.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const foldHelp = {
  name: "fold",
  summary: "wrap each input line to fit in specified width",
  usage: "fold [OPTION]... [FILE]...",
  description:
    "Wrap input lines in each FILE, writing to standard output. If no FILE is specified, standard input is read.",
  options: [
    "-w WIDTH    Use WIDTH columns instead of 80",
    "-s          Break at spaces",
    "-b          Count bytes rather than columns"
  ],
  examples: [
    "fold -w 40 file.txt           # Wrap at 40 columns",
    "fold -sw 40 file.txt          # Word wrap at 40 columns",
    "echo 'long line' | fold -w 5  # Force wrap at 5"
  ]
};

interface FoldOptions {
  width: number;
  breakAtSpaces: boolean;
  countBytes: boolean;
}

/**
 * Get the display width of a character, handling tabs.
 * For tabs, we need the current column to calculate width.
 */
function getCharWidth(
  char: string,
  currentColumn: number,
  countBytes: boolean
): number {
  if (countBytes) {
    // In byte mode, each character is 1 byte (simplified - assumes ASCII)
    return new TextEncoder().encode(char).length;
  }

  if (char === "\t") {
    // Tab expands to next 8-column boundary
    return 8 - (currentColumn % 8);
  }

  if (char === "\b") {
    // Backspace moves back one column
    return -1;
  }

  // Regular characters are 1 column
  return 1;
}

function foldLine(line: string, options: FoldOptions): string {
  if (line.length === 0) {
    return line;
  }

  const { width, breakAtSpaces, countBytes } = options;
  const result: string[] = [];
  let currentLine = "";
  let currentColumn = 0;
  let lastSpaceIndex = -1;
  let lastSpaceColumn = 0;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const charWidth = getCharWidth(char, currentColumn, countBytes);

    // Would this character exceed the width?
    if (currentColumn + charWidth > width && currentLine.length > 0) {
      if (breakAtSpaces && lastSpaceIndex >= 0) {
        // Break at the last space
        result.push(currentLine.slice(0, lastSpaceIndex + 1));
        currentLine = currentLine.slice(lastSpaceIndex + 1) + char;
        currentColumn = currentColumn - lastSpaceColumn - 1 + charWidth;
        lastSpaceIndex = -1;
        lastSpaceColumn = 0;
      } else {
        // Break at current position
        result.push(currentLine);
        currentLine = char;
        currentColumn = charWidth;
        lastSpaceIndex = -1;
        lastSpaceColumn = 0;
      }
    } else {
      currentLine += char;
      currentColumn += charWidth;

      // Track last space position
      if (char === " " || char === "\t") {
        lastSpaceIndex = currentLine.length - 1;
        lastSpaceColumn = currentColumn - charWidth;
      }
    }
  }

  if (currentLine.length > 0) {
    result.push(currentLine);
  }

  return result.join("\n");
}

function processContent(content: string, options: FoldOptions): string {
  // Handle empty input
  if (content === "") {
    return "";
  }

  const lines = content.split("\n");
  const hasTrailingNewline =
    content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }

  const foldedLines = lines.map((line) => foldLine(line, options));
  return foldedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}

export const fold: Command = {
  name: "fold",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(foldHelp);
    }

    const options: FoldOptions = {
      width: 80,
      breakAtSpaces: false,
      countBytes: false
    };

    const files: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      if (arg === "-w" && i + 1 < args.length) {
        const width = parseInt(args[i + 1], 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${args[i + 1]}'\n`
          };
        }
        options.width = width;
        i += 2;
      } else if (arg.startsWith("-w") && arg.length > 2) {
        const width = parseInt(arg.slice(2), 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${arg.slice(2)}'\n`
          };
        }
        options.width = width;
        i++;
      } else if (arg === "-s") {
        options.breakAtSpaces = true;
        i++;
      } else if (arg === "-b") {
        options.countBytes = true;
        i++;
      } else if (arg === "-bs" || arg === "-sb") {
        options.breakAtSpaces = true;
        options.countBytes = true;
        i++;
      } else if (arg.match(/^-[sb]+w\d+$/)) {
        // Handle combined flags like -sw10 (with width attached)
        if (arg.includes("s")) options.breakAtSpaces = true;
        if (arg.includes("b")) options.countBytes = true;
        const widthPart = arg.replace(/^-[sb]+w/, "");
        const width = parseInt(widthPart, 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${widthPart}'\n`
          };
        }
        options.width = width;
        i++;
      } else if (arg.match(/^-[sb]+w$/) && i + 1 < args.length) {
        // Handle combined flags like -sw 10 (with width as next arg)
        if (arg.includes("s")) options.breakAtSpaces = true;
        if (arg.includes("b")) options.countBytes = true;
        const width = parseInt(args[i + 1], 10);
        if (Number.isNaN(width) || width < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `fold: invalid number of columns: '${args[i + 1]}'\n`
          };
        }
        options.width = width;
        i += 2;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        // Check for combined short flags like -sb
        const flags = arg.slice(1);
        let hasUnknown = false;
        for (const flag of flags) {
          if (flag === "s") {
            options.breakAtSpaces = true;
          } else if (flag === "b") {
            options.countBytes = true;
          } else {
            hasUnknown = true;
            break;
          }
        }
        if (hasUnknown) {
          return unknownOption("fold", arg);
        }
        i++;
      } else {
        files.push(arg);
        i++;
      }
    }

    let output = "";

    if (files.length === 0) {
      // Read from stdin
      const input = ctx.stdin ?? "";
      output = processContent(input, options);
    } else {
      // Process each file
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: output,
            stderr: `fold: ${file}: No such file or directory\n`
          };
        }
        output += processContent(content, options);
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
  name: "fold",
  flags: [
    { flag: "-w", type: "value", valueHint: "number" },
    { flag: "-s", type: "boolean" },
    { flag: "-b", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
