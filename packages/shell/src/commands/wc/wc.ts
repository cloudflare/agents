import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { readFiles } from "../../utils/file-reader";
import { hasHelpFlag, showHelp } from "../help";

const wcHelp = {
  name: "wc",
  summary: "print newline, word, and byte counts for each file",
  usage: "wc [OPTION]... [FILE]...",
  options: [
    "-c, --bytes      print the byte counts",
    "-m, --chars      print the character counts",
    "-l, --lines      print the newline counts",
    "-w, --words      print the word counts",
    "    --help       display this help and exit"
  ]
};

const argDefs = {
  lines: { short: "l", long: "lines", type: "boolean" as const },
  words: { short: "w", long: "words", type: "boolean" as const },
  bytes: { short: "c", long: "bytes", type: "boolean" as const },
  chars: { short: "m", long: "chars", type: "boolean" as const }
};

export const wcCommand: Command = {
  name: "wc",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(wcHelp);
    }

    const parsed = parseArgs("wc", args, argDefs);
    if (!parsed.ok) return parsed.error;

    let { lines: showLines, words: showWords } = parsed.result.flags;
    // -c (bytes) and -m (chars) both show character counts
    let showChars = parsed.result.flags.bytes || parsed.result.flags.chars;
    const files = parsed.result.positional;

    // If no flags specified, show all
    if (!showLines && !showWords && !showChars) {
      showLines = showWords = showChars = true;
    }

    // Read files
    const readResult = await readFiles(ctx, files, {
      cmdName: "wc",
      stopOnError: false
    });

    // If reading from stdin (no files), use simpler output
    if (files.length === 0) {
      const stats = countStats(readResult.files[0].content);
      return {
        stdout: `${formatStats(stats, showLines, showWords, showChars, "", 0)}\n`,
        stderr: "",
        exitCode: 0
      };
    }

    // First pass: count stats for all files and calculate max widths
    const allStats: Array<{
      filename: string;
      stats: { lines: number; words: number; chars: number };
    }> = [];
    let totalLines = 0;
    let totalWords = 0;
    let totalChars = 0;

    for (const { filename, content } of readResult.files) {
      const stats = countStats(content);
      totalLines += stats.lines;
      totalWords += stats.words;
      totalChars += stats.chars;
      allStats.push({ filename, stats });
    }

    // Calculate the max width needed for alignment
    // Consider totals if we have multiple files
    const maxLines =
      files.length > 1
        ? totalLines
        : Math.max(...allStats.map((s) => s.stats.lines));
    const maxWords =
      files.length > 1
        ? totalWords
        : Math.max(...allStats.map((s) => s.stats.words));
    const maxChars =
      files.length > 1
        ? totalChars
        : Math.max(...allStats.map((s) => s.stats.chars));

    // Calculate width based on which columns are shown
    // Use minimum width of 3 for alignment when there are multiple files (matches osh behavior)
    let maxWidth = files.length > 1 ? 3 : 0;
    if (showLines) maxWidth = Math.max(maxWidth, String(maxLines).length);
    if (showWords) maxWidth = Math.max(maxWidth, String(maxWords).length);
    if (showChars) maxWidth = Math.max(maxWidth, String(maxChars).length);

    // Second pass: format output with proper alignment
    let stdout = "";
    for (const { filename, stats } of allStats) {
      stdout += `${formatStats(stats, showLines, showWords, showChars, filename, maxWidth)}\n`;
    }

    // Show total for multiple files
    if (files.length > 1) {
      stdout += `${formatStats(
        { lines: totalLines, words: totalWords, chars: totalChars },
        showLines,
        showWords,
        showChars,
        "total",
        maxWidth
      )}\n`;
    }

    return { stdout, stderr: readResult.stderr, exitCode: readResult.exitCode };
  }
};

function countStats(content: string): {
  lines: number;
  words: number;
  chars: number;
} {
  const len = content.length;
  let lines = 0;
  let words = 0;
  let inWord = false;

  // Single pass through content to count lines and words
  for (let i = 0; i < len; i++) {
    const c = content[i];
    if (c === "\n") {
      lines++;
      if (inWord) {
        words++;
        inWord = false;
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      if (inWord) {
        words++;
        inWord = false;
      }
    } else {
      inWord = true;
    }
  }

  // Count final word if content doesn't end with whitespace
  if (inWord) {
    words++;
  }

  return { lines, words, chars: len };
}

function formatStats(
  stats: { lines: number; words: number; chars: number },
  showLines: boolean,
  showWords: boolean,
  showChars: boolean,
  filename: string,
  minWidth: number
): string {
  const values: string[] = [];
  if (showLines) {
    values.push(String(stats.lines).padStart(minWidth));
  }
  if (showWords) {
    values.push(String(stats.words).padStart(minWidth));
  }
  if (showChars) {
    values.push(String(stats.chars).padStart(minWidth));
  }

  let result = values.join(" ");
  if (filename) {
    result += ` ${filename}`;
  }

  return result;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "wc",
  flags: [
    { flag: "-l", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-m", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
