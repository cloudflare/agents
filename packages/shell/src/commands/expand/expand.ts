/**
 * expand - convert tabs to spaces
 *
 * Usage: expand [OPTION]... [FILE]...
 *
 * Convert TABs in each FILE to spaces, writing to standard output.
 * If no FILE is specified, standard input is read.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const expandHelp = {
  name: "expand",
  summary: "convert tabs to spaces",
  usage: "expand [OPTION]... [FILE]...",
  description:
    "Convert TABs in each FILE to spaces, writing to standard output. If no FILE is specified, standard input is read.",
  options: [
    "-t N        Use N spaces per tab (default: 8)",
    "-t LIST     Use comma-separated list of tab stops",
    "-i          Only convert leading tabs on each line"
  ],
  examples: [
    "expand file.txt             # Convert all tabs to 8 spaces",
    "expand -t 4 file.txt        # Use 4-space tabs",
    "expand -t 4,8,12 file.txt   # Custom tab stops"
  ]
};

interface ExpandOptions {
  tabStops: number[];
  leadingOnly: boolean;
}

/**
 * Parse tab stop specification. Can be:
 * - A single number: "4" -> use that as uniform tab width
 * - A comma-separated list: "4,8,12" -> explicit tab stop positions
 */
function parseTabStops(spec: string): number[] | null {
  const parts = spec.split(",").map((s) => s.trim());
  const stops: number[] = [];

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (Number.isNaN(num) || num < 1) {
      return null;
    }
    stops.push(num);
  }

  // Validate that stops are in ascending order
  for (let i = 1; i < stops.length; i++) {
    if (stops[i] <= stops[i - 1]) {
      return null;
    }
  }

  return stops;
}

/**
 * Get the number of spaces to reach the next tab stop from current column.
 * Column positions are 0-based.
 */
function getTabWidth(column: number, tabStops: number[]): number {
  if (tabStops.length === 1) {
    // Single value means uniform tab width
    const tabWidth = tabStops[0];
    return tabWidth - (column % tabWidth);
  }

  // Find the next tab stop position after current column
  for (const stop of tabStops) {
    if (stop > column) {
      return stop - column;
    }
  }

  // If past all explicit stops, use the last interval
  if (tabStops.length >= 2) {
    const lastInterval =
      tabStops[tabStops.length - 1] - tabStops[tabStops.length - 2];
    const lastStop = tabStops[tabStops.length - 1];
    const stopsAfterLast = Math.floor((column - lastStop) / lastInterval) + 1;
    const nextStop = lastStop + stopsAfterLast * lastInterval;
    return nextStop - column;
  }

  // Default: 1 space if past all stops
  return 1;
}

function expandLine(line: string, options: ExpandOptions): string {
  const { tabStops, leadingOnly } = options;
  let result = "";
  let column = 0;
  let inLeadingWhitespace = true;

  for (const char of line) {
    if (char === "\t") {
      if (leadingOnly && !inLeadingWhitespace) {
        result += char;
        column++; // Treat unexpanded tab as 1 column
      } else {
        const spaces = getTabWidth(column, tabStops);
        result += " ".repeat(spaces);
        column += spaces;
      }
    } else {
      if (char !== " " && char !== "\t") {
        inLeadingWhitespace = false;
      }
      result += char;
      column++;
    }
  }

  return result;
}

function processContent(content: string, options: ExpandOptions): string {
  if (content === "") {
    return "";
  }

  const lines = content.split("\n");
  const hasTrailingNewline =
    content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }

  const expandedLines = lines.map((line) => expandLine(line, options));
  return expandedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}

export const expand: Command = {
  name: "expand",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(expandHelp);
    }

    const options: ExpandOptions = {
      tabStops: [8],
      leadingOnly: false
    };

    const files: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      if (arg === "-t" && i + 1 < args.length) {
        const stops = parseTabStops(args[i + 1]);
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${args[i + 1]}'\n`
          };
        }
        options.tabStops = stops;
        i += 2;
      } else if (arg.startsWith("-t") && arg.length > 2) {
        const stops = parseTabStops(arg.slice(2));
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${arg.slice(2)}'\n`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "--tabs" && i + 1 < args.length) {
        const stops = parseTabStops(args[i + 1]);
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${args[i + 1]}'\n`
          };
        }
        options.tabStops = stops;
        i += 2;
      } else if (arg.startsWith("--tabs=")) {
        const stops = parseTabStops(arg.slice(7));
        if (!stops) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `expand: invalid tab size: '${arg.slice(7)}'\n`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "-i" || arg === "--initial") {
        options.leadingOnly = true;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("expand", arg);
      } else {
        files.push(arg);
        i++;
      }
    }

    let output = "";

    if (files.length === 0) {
      const input = ctx.stdin ?? "";
      output = processContent(input, options);
    } else {
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        if (content === null) {
          return {
            exitCode: 1,
            stdout: output,
            stderr: `expand: ${file}: No such file or directory\n`
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
  name: "expand",
  flags: [
    { flag: "-t", type: "value", valueHint: "number" },
    { flag: "-i", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
