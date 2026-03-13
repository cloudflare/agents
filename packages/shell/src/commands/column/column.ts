/**
 * column - columnate lists
 *
 * Usage: column [OPTION]... [FILE]...
 *
 * Columnate input. Fill rows first by default, or create a table with -t.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const columnHelp = {
  name: "column",
  summary: "columnate lists",
  usage: "column [OPTION]... [FILE]...",
  description:
    "Format input into multiple columns. By default, fills rows first. Use -t to create a table based on whitespace-delimited input.",
  options: [
    "-t           Create a table (determine columns from input)",
    "-s SEP       Input field delimiter (default: whitespace)",
    "-o SEP       Output field delimiter (default: two spaces)",
    "-c WIDTH     Output width for fill mode (default: 80)",
    "-n           Don't merge multiple adjacent delimiters"
  ],
  examples: [
    "ls | column              # Fill columns with ls output",
    "cat data | column -t     # Format as table",
    "column -t -s ',' file    # Format CSV as table",
    "column -c 40 file        # Fill 40-char wide columns"
  ]
};

const argDefs = {
  table: { short: "t", long: "table", type: "boolean" as const },
  separator: { short: "s", type: "string" as const },
  outputSep: { short: "o", type: "string" as const },
  width: { short: "c", type: "number" as const, default: 80 },
  noMerge: { short: "n", type: "boolean" as const }
};

/**
 * Split a line into fields based on separator.
 * If noMerge is false, consecutive delimiters are treated as one.
 */
function splitFields(
  line: string,
  separator: string | undefined,
  noMerge: boolean
): string[] {
  if (separator) {
    if (noMerge) {
      return line.split(separator);
    }
    // Split by separator, removing empty fields from consecutive separators
    return line.split(separator).filter((f) => f.length > 0);
  }

  // Default: split by whitespace
  if (noMerge) {
    // With -n, preserve empty fields between whitespace
    return line.split(/[ \t]/);
  }
  // Default: consecutive whitespace is one delimiter
  return line.split(/[ \t]+/).filter((f) => f.length > 0);
}

/**
 * Calculate the maximum width for each column.
 */
function calculateColumnWidths(rows: string[][]): number[] {
  const widths: number[] = [];

  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cellWidth = row[i].length;
      if (widths[i] === undefined || cellWidth > widths[i]) {
        widths[i] = cellWidth;
      }
    }
  }

  return widths;
}

/**
 * Format rows as a table with aligned columns.
 */
function formatTable(rows: string[][], outputSep: string): string {
  if (rows.length === 0) return "";

  const widths = calculateColumnWidths(rows);
  const lines: string[] = [];

  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < row.length; i++) {
      // Last column doesn't need padding
      if (i === row.length - 1) {
        cells.push(row[i]);
      } else {
        cells.push(row[i].padEnd(widths[i]));
      }
    }
    lines.push(cells.join(outputSep));
  }

  return lines.join("\n");
}

/**
 * Fill mode: arrange items into columns that fit within width.
 */
function formatFill(items: string[], width: number, outputSep: string): string {
  if (items.length === 0) return "";

  // Find the maximum item width
  const maxItemWidth = Math.max(...items.map((item) => item.length));
  const sepWidth = outputSep.length;

  // Calculate how many columns can fit
  // Each column needs maxItemWidth + separator (except last)
  const columnWidth = maxItemWidth + sepWidth;
  const numColumns = Math.max(1, Math.floor((width + sepWidth) / columnWidth));

  // Calculate number of rows
  const numRows = Math.ceil(items.length / numColumns);

  // Build rows, filling column by column (down, then right)
  const lines: string[] = [];
  for (let row = 0; row < numRows; row++) {
    const cells: string[] = [];
    for (let col = 0; col < numColumns; col++) {
      const index = col * numRows + row;
      if (index < items.length) {
        // Last column in row doesn't need padding
        const isLastInRow =
          col === numColumns - 1 || (col + 1) * numRows + row >= items.length;
        if (isLastInRow) {
          cells.push(items[index]);
        } else {
          cells.push(items[index].padEnd(maxItemWidth));
        }
      }
    }
    lines.push(cells.join(outputSep));
  }

  return lines.join("\n");
}

export const column: Command = {
  name: "column",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(columnHelp);
    }

    const parsed = parseArgs("column", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { table, separator, outputSep, width, noMerge } = parsed.result.flags;
    const files = parsed.result.positional;

    // Default output separator is two spaces
    const outSep = outputSep ?? "  ";

    // Read input
    let content: string;
    if (files.length === 0) {
      content = ctx.stdin ?? "";
    } else {
      const parts: string[] = [];
      for (const file of files) {
        if (file === "-") {
          parts.push(ctx.stdin ?? "");
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          const fileContent = await ctx.fs.readFile(filePath);
          if (fileContent === null) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `column: ${file}: No such file or directory\n`
            };
          }
          parts.push(fileContent);
        }
      }
      content = parts.join("");
    }

    // Handle empty input
    if (content === "" || content.trim() === "") {
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }

    // Split into lines, handling trailing newline
    const lines = content.split("\n");
    const hasTrailingNewline =
      content.endsWith("\n") && lines[lines.length - 1] === "";
    if (hasTrailingNewline) {
      lines.pop();
    }

    // Filter empty lines
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

    let output: string;

    if (table) {
      // Table mode: split each line into fields and align
      const rows = nonEmptyLines.map((line) =>
        splitFields(line, separator, noMerge)
      );
      output = formatTable(rows, outSep);
    } else {
      // Fill mode: collect all items and arrange into columns
      const items: string[] = [];
      for (const line of nonEmptyLines) {
        const fields = splitFields(line, separator, noMerge);
        items.push(...fields);
      }
      output = formatFill(items, width, outSep);
    }

    // Add trailing newline if there was output
    if (output.length > 0) {
      output += "\n";
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
  name: "column",
  flags: [
    { flag: "-t", type: "boolean" },
    { flag: "-s", type: "value", valueHint: "delimiter" },
    { flag: "-o", type: "value", valueHint: "string" },
    { flag: "-c", type: "value", valueHint: "number" },
    { flag: "-n", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
