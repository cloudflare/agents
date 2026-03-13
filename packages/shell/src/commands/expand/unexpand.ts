/**
 * unexpand - convert spaces to tabs
 *
 * Usage: unexpand [OPTION]... [FILE]...
 *
 * Convert blanks in each FILE to TABs, writing to standard output.
 * If no FILE is specified, standard input is read.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const unexpandHelp = {
  name: "unexpand",
  summary: "convert spaces to tabs",
  usage: "unexpand [OPTION]... [FILE]...",
  description:
    "Convert blanks in each FILE to TABs, writing to standard output. If no FILE is specified, standard input is read.",
  options: [
    "-t N        Use N spaces per tab (default: 8)",
    "-t LIST     Use comma-separated list of tab stops",
    "-a          Convert all sequences of blanks (not just leading)"
  ],
  examples: [
    "unexpand file.txt           # Convert leading spaces to tabs",
    "unexpand -a file.txt        # Convert all space sequences",
    "unexpand -t 4 file.txt      # Use 4-space tabs"
  ]
};

interface UnexpandOptions {
  tabStops: number[];
  allBlanks: boolean;
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
 * Get the next tab stop position from current column.
 * Returns the tab stop column, or -1 if no valid tab stop.
 */
function getNextTabStop(column: number, tabStops: number[]): number {
  if (tabStops.length === 1) {
    // Single value means uniform tab width
    const tabWidth = tabStops[0];
    return column + (tabWidth - (column % tabWidth));
  }

  // Find the next tab stop position after current column
  for (const stop of tabStops) {
    if (stop > column) {
      return stop;
    }
  }

  // If past all explicit stops, use the last interval
  if (tabStops.length >= 2) {
    const lastInterval =
      tabStops[tabStops.length - 1] - tabStops[tabStops.length - 2];
    const lastStop = tabStops[tabStops.length - 1];
    const stopsAfterLast = Math.floor((column - lastStop) / lastInterval) + 1;
    return lastStop + stopsAfterLast * lastInterval;
  }

  return -1;
}

function unexpandLine(line: string, options: UnexpandOptions): string {
  const { tabStops, allBlanks } = options;
  let result = "";
  let column = 0;
  let spaceRun = "";
  let spaceRunStart = 0;
  let inLeadingBlanks = true;

  const flushSpaces = (): void => {
    if (spaceRun.length === 0) return;

    // Only convert if we started at a position where conversion makes sense
    // and we end at (or past) a tab stop
    const endColumn = spaceRunStart + spaceRun.length;

    if (!allBlanks && !inLeadingBlanks) {
      // Only leading blanks mode - output spaces as-is
      result += spaceRun;
      spaceRun = "";
      return;
    }

    // Try to convert to tabs
    let currentPos = spaceRunStart;
    let converted = "";

    while (currentPos < endColumn) {
      const nextStop = getNextTabStop(currentPos, tabStops);
      if (nextStop <= endColumn && nextStop > currentPos) {
        // We can replace spaces up to nextStop with a tab
        converted += "\t";
        currentPos = nextStop;
      } else {
        // Remaining spaces can't form a complete tab
        break;
      }
    }

    // Add any remaining spaces
    const remaining = endColumn - currentPos;
    if (remaining > 0) {
      converted += " ".repeat(remaining);
    }

    result += converted;
    spaceRun = "";
  };

  for (const char of line) {
    if (char === " ") {
      if (spaceRun.length === 0) {
        spaceRunStart = column;
      }
      spaceRun += char;
      column++;
    } else if (char === "\t") {
      flushSpaces();
      result += char;
      // Move to next tab stop
      column = getNextTabStop(column, tabStops);
    } else {
      flushSpaces();
      result += char;
      column++;
      inLeadingBlanks = false;
    }
  }

  flushSpaces();
  return result;
}

function processContent(content: string, options: UnexpandOptions): string {
  if (content === "") {
    return "";
  }

  const lines = content.split("\n");
  const hasTrailingNewline =
    content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }

  const unexpandedLines = lines.map((line) => unexpandLine(line, options));
  return unexpandedLines.join("\n") + (hasTrailingNewline ? "\n" : "");
}

export const unexpand: Command = {
  name: "unexpand",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(unexpandHelp);
    }

    const options: UnexpandOptions = {
      tabStops: [8],
      allBlanks: false
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
            stderr: `unexpand: invalid tab size: '${args[i + 1]}'\n`
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
            stderr: `unexpand: invalid tab size: '${arg.slice(2)}'\n`
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
            stderr: `unexpand: invalid tab size: '${args[i + 1]}'\n`
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
            stderr: `unexpand: invalid tab size: '${arg.slice(7)}'\n`
          };
        }
        options.tabStops = stops;
        i++;
      } else if (arg === "-a" || arg === "--all") {
        options.allBlanks = true;
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("unexpand", arg);
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
            stderr: `unexpand: ${file}: No such file or directory\n`
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
  name: "unexpand",
  flags: [
    { flag: "-t", type: "value", valueHint: "number" },
    { flag: "-a", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
