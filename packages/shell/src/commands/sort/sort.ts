import type { Command, CommandContext, ExecResult } from "../../types";
import { readAndConcat } from "../../utils/file-reader";
import { hasHelpFlag, showHelp, unknownOption } from "../help";
import { createComparator, filterUnique } from "./comparator";
import { parseKeySpec } from "./parser";
import type { SortOptions } from "./types";

const sortHelp = {
  name: "sort",
  summary: "sort lines of text files",
  usage: "sort [OPTION]... [FILE]...",
  options: [
    "-b, --ignore-leading-blanks  ignore leading blanks",
    "-d, --dictionary-order  consider only blanks and alphanumeric characters",
    "-f, --ignore-case    fold lower case to upper case characters",
    "-h, --human-numeric-sort  compare human readable numbers (e.g., 2K 1G)",
    "-M, --month-sort     compare (unknown) < 'JAN' < ... < 'DEC'",
    "-n, --numeric-sort   compare according to string numerical value",
    "-r, --reverse        reverse the result of comparisons",
    "-V, --version-sort   natural sort of (version) numbers within text",
    "-c, --check          check for sorted input; do not sort",
    "-o, --output=FILE    write result to FILE instead of stdout",
    "-s, --stable         stabilize sort by disabling last-resort comparison",
    "-u, --unique         output only unique lines",
    "-k, --key=KEYDEF     sort via a key; KEYDEF gives location and type",
    "-t, --field-separator=SEP  use SEP as field separator",
    "    --help           display this help and exit"
  ],
  description: `KEYDEF is F[.C][OPTS][,F[.C][OPTS]]
  F is a field number (1-indexed)
  C is a character position within the field (1-indexed)
  OPTS can be: b d f h M n r V (per-key modifiers)

Examples:
  -k1        sort by first field
  -k2,2      sort by second field only
  -k1.3      sort by first field starting at 3rd character
  -k1,2n     sort by fields 1-2 numerically
  -k2 -k1    sort by field 2, then by field 1`
};

export const sortCommand: Command = {
  name: "sort",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(sortHelp);
    }

    const options: SortOptions = {
      reverse: false,
      numeric: false,
      unique: false,
      ignoreCase: false,
      humanNumeric: false,
      versionSort: false,
      dictionaryOrder: false,
      monthSort: false,
      ignoreLeadingBlanks: false,
      stable: false,
      checkOnly: false,
      outputFile: null,
      keys: [],
      fieldDelimiter: null
    };
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-r" || arg === "--reverse") {
        options.reverse = true;
      } else if (arg === "-n" || arg === "--numeric-sort") {
        options.numeric = true;
      } else if (arg === "-u" || arg === "--unique") {
        options.unique = true;
      } else if (arg === "-f" || arg === "--ignore-case") {
        options.ignoreCase = true;
      } else if (arg === "-h" || arg === "--human-numeric-sort") {
        options.humanNumeric = true;
      } else if (arg === "-V" || arg === "--version-sort") {
        options.versionSort = true;
      } else if (arg === "-d" || arg === "--dictionary-order") {
        options.dictionaryOrder = true;
      } else if (arg === "-M" || arg === "--month-sort") {
        options.monthSort = true;
      } else if (arg === "-b" || arg === "--ignore-leading-blanks") {
        options.ignoreLeadingBlanks = true;
      } else if (arg === "-s" || arg === "--stable") {
        options.stable = true;
      } else if (arg === "-c" || arg === "--check") {
        options.checkOnly = true;
      } else if (arg === "-o" || arg === "--output") {
        options.outputFile = args[++i] || null;
      } else if (arg.startsWith("-o")) {
        options.outputFile = arg.slice(2) || null;
      } else if (arg.startsWith("--output=")) {
        options.outputFile = arg.slice(9) || null;
      } else if (arg === "-t" || arg === "--field-separator") {
        options.fieldDelimiter = args[++i] || null;
      } else if (arg.startsWith("-t")) {
        options.fieldDelimiter = arg.slice(2) || null;
      } else if (arg.startsWith("--field-separator=")) {
        options.fieldDelimiter = arg.slice(18) || null;
      } else if (arg === "-k" || arg === "--key") {
        const keyArg = args[++i];
        if (keyArg) {
          const keySpec = parseKeySpec(keyArg);
          if (keySpec) {
            options.keys.push(keySpec);
          }
        }
      } else if (arg.startsWith("-k")) {
        const keySpec = parseKeySpec(arg.slice(2));
        if (keySpec) {
          options.keys.push(keySpec);
        }
      } else if (arg.startsWith("--key=")) {
        const keySpec = parseKeySpec(arg.slice(6));
        if (keySpec) {
          options.keys.push(keySpec);
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("sort", arg);
      } else if (arg.startsWith("-") && !arg.startsWith("--")) {
        // Handle combined flags like -rn
        let hasUnknown = false;
        for (const char of arg.slice(1)) {
          if (char === "r") options.reverse = true;
          else if (char === "n") options.numeric = true;
          else if (char === "u") options.unique = true;
          else if (char === "f") options.ignoreCase = true;
          else if (char === "h") options.humanNumeric = true;
          else if (char === "V") options.versionSort = true;
          else if (char === "d") options.dictionaryOrder = true;
          else if (char === "M") options.monthSort = true;
          else if (char === "b") options.ignoreLeadingBlanks = true;
          else if (char === "s") options.stable = true;
          else if (char === "c") options.checkOnly = true;
          else {
            hasUnknown = true;
            break;
          }
        }
        if (hasUnknown) {
          return unknownOption("sort", arg);
        }
      } else {
        files.push(arg);
      }
    }

    // Read from files or stdin
    const readResult = await readAndConcat(ctx, files, { cmdName: "sort" });
    if (!readResult.ok) return readResult.error;
    const content = readResult.content;

    // Split into lines (preserve empty lines at the end for sorting)
    let lines = content.split("\n");

    // Remove last empty element if content ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    // Create comparator
    const comparator = createComparator(options);

    // Check mode: verify if already sorted
    if (options.checkOnly) {
      const checkFile = files.length > 0 ? files[0] : "-";
      for (let i = 1; i < lines.length; i++) {
        if (comparator(lines[i - 1], lines[i]) > 0) {
          return {
            stdout: "",
            stderr: `sort: ${checkFile}:${i + 1}: disorder: ${lines[i]}\n`,
            exitCode: 1
          };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Sort lines using the comparator
    lines.sort(comparator);

    // Remove duplicates if -u
    if (options.unique) {
      lines = filterUnique(lines, options);
    }

    const output = lines.length > 0 ? `${lines.join("\n")}\n` : "";

    // Output to file if -o specified
    if (options.outputFile) {
      const outPath = ctx.fs.resolvePath(ctx.cwd, options.outputFile);
      // Content was read with binary encoding (readAndConcat), write as binary
      // to preserve UTF-8 byte sequences
      await ctx.fs.writeFile(outPath, output, "binary");
      return { stdout: "", stderr: "", exitCode: 0 };
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
  name: "sort",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-u", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-h", type: "boolean" },
    { flag: "-V", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-M", type: "boolean" },
    { flag: "-b", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-k", type: "value", valueHint: "string" },
    { flag: "-t", type: "value", valueHint: "delimiter" },
    { flag: "-o", type: "value", valueHint: "path" }
  ],
  stdinType: "text",
  needsFiles: true
};
