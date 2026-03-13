/**
 * rg - ripgrep-like recursive search
 *
 * Fast recursive search with smart defaults:
 * - Recursive by default (unlike grep)
 * - Respects .gitignore
 * - Skips hidden files by default
 * - Skips binary files by default
 * - Smart case sensitivity (case-insensitive unless pattern has uppercase)
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";
import { formatTypeList } from "./file-types";
import { parseArgs } from "./rg-parser";
import { executeSearch } from "./rg-search";

const rgHelp = {
  name: "rg",
  summary: "recursively search for a pattern",
  usage: "rg [OPTIONS] PATTERN [PATH ...]",
  description: `rg (ripgrep) recursively searches directories for a regex pattern.
Unlike grep, rg is recursive by default and respects .gitignore files.

EXAMPLES:
  rg foo                    Search for 'foo' in current directory
  rg foo src/               Search in src/ directory
  rg -i foo                 Case-insensitive search
  rg -w foo                 Match whole words only
  rg -t js foo              Search only JavaScript files
  rg -g '*.ts' foo          Search files matching glob
  rg --hidden foo           Include hidden files
  rg -l foo                 List files with matches only`,
  options: [
    "-e, --regexp PATTERN    search for PATTERN (can be used multiple times)",
    "-f, --file FILE         read patterns from FILE, one per line",
    "-i, --ignore-case       case-insensitive search",
    "-s, --case-sensitive    case-sensitive search (overrides smart-case)",
    "-S, --smart-case        smart case (default: case-insensitive unless pattern has uppercase)",
    "-F, --fixed-strings     treat pattern as literal string",
    "-w, --word-regexp       match whole words only",
    "-x, --line-regexp       match whole lines only",
    "-v, --invert-match      select non-matching lines",
    "-r, --replace TEXT      replace matches with TEXT",
    "-c, --count             print count of matching lines per file",
    "    --count-matches     print count of individual matches per file",
    "-l, --files-with-matches print only file names with matches",
    "    --files-without-match print file names without matches",
    "    --files             list files that would be searched",
    "-o, --only-matching     print only matching parts",
    "-m, --max-count NUM     stop after NUM matches per file",
    "-q, --quiet             suppress output, exit 0 on match",
    "    --stats             print search statistics",
    "-n, --line-number       print line numbers (default: on)",
    "-N, --no-line-number    do not print line numbers",
    "-I, --no-filename       suppress the prefixing of file names",
    "-0, --null              use NUL as filename separator",
    "-b, --byte-offset       show byte offset of each match",
    "    --column            show column number of first match",
    "    --vimgrep           show results in vimgrep format",
    "    --json              show results in JSON Lines format",
    "-A NUM                  print NUM lines after each match",
    "-B NUM                  print NUM lines before each match",
    "-C NUM                  print NUM lines before and after each match",
    "    --context-separator SEP  separator for context groups (default: --)",
    "-U, --multiline         match patterns across lines",
    "-z, --search-zip        search in compressed files (gzip only)",
    "-g, --glob GLOB         include files matching GLOB",
    "-t, --type TYPE         only search files of TYPE (e.g., js, py, ts)",
    "-T, --type-not TYPE     exclude files of TYPE",
    "-L, --follow            follow symbolic links",
    "-u, --unrestricted      reduce filtering (-u: no ignore, -uu: +hidden, -uuu: +binary)",
    "-a, --text              search binary files as text",
    "    --hidden            search hidden files and directories",
    "    --no-ignore         don't respect .gitignore/.ignore files",
    "-d, --max-depth NUM     maximum search depth",
    "    --sort TYPE         sort files (path, none)",
    "    --heading           show file path above matches",
    "    --passthru          print all lines (non-matches use - separator)",
    "    --include-zero      include files with 0 matches in count output",
    "    --type-list         list all available file types",
    "    --help              display this help and exit"
  ]
};

export const rgCommand: Command = {
  name: "rg",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(rgHelp);
    }

    if (args.includes("--type-list")) {
      return {
        stdout: formatTypeList(),
        stderr: "",
        exitCode: 0
      };
    }

    const parseResult = parseArgs(args);
    if (!parseResult.success) {
      return parseResult.error;
    }

    return executeSearch({
      ctx,
      options: parseResult.options,
      paths: parseResult.paths,
      explicitLineNumbers: parseResult.explicitLineNumbers
    });
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "rg",
  flags: [
    { flag: "-i", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-S", type: "boolean" },
    { flag: "-F", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-x", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-l", type: "boolean" },
    { flag: "-o", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-N", type: "boolean" },
    { flag: "--hidden", type: "boolean" },
    { flag: "--no-ignore", type: "boolean" },
    { flag: "-m", type: "value", valueHint: "number" },
    { flag: "-A", type: "value", valueHint: "number" },
    { flag: "-B", type: "value", valueHint: "number" },
    { flag: "-C", type: "value", valueHint: "number" },
    { flag: "-g", type: "value", valueHint: "pattern" },
    { flag: "-t", type: "value", valueHint: "string" },
    { flag: "-T", type: "value", valueHint: "string" }
  ],
  needsArgs: true
};
