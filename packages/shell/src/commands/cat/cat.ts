import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { readFiles } from "../../utils/file-reader";
import { hasHelpFlag, showHelp } from "../help";

const catHelp = {
  name: "cat",
  summary: "concatenate files and print on the standard output",
  usage: "cat [OPTION]... [FILE]...",
  options: [
    "-n, --number           number all output lines",
    "    --help             display this help and exit"
  ]
};

const argDefs = {
  number: { short: "n", long: "number", type: "boolean" as const }
};

export const catCommand: Command = {
  name: "cat",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(catHelp);
    }

    const parsed = parseArgs("cat", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const showLineNumbers = parsed.result.flags.number;
    const files = parsed.result.positional;

    // Read files (allows "-" for stdin)
    const readResult = await readFiles(ctx, files, {
      cmdName: "cat",
      allowStdinMarker: true,
      stopOnError: false
    });

    let stdout = "";
    let lineNumber = 1;

    for (const { content } of readResult.files) {
      if (showLineNumbers) {
        // Real bash continues line numbers across files
        const result = addLineNumbers(content, lineNumber);
        stdout += result.content;
        lineNumber = result.nextLineNumber;
      } else {
        stdout += content;
      }
    }

    // Only use binary encoding when reading actual files (not just stdin).
    // When reading from stdin (heredoc, here-string, pipeline text), the
    // content may be Unicode text that needs UTF-8 encoding for file writes.
    // File content is read with binary encoding and needs binary to preserve bytes.
    const isReadingFiles = files.length > 0 && files.some((f) => f !== "-");
    return {
      stdout,
      stderr: readResult.stderr,
      exitCode: readResult.exitCode,
      // @banned-pattern-ignore: spread into static result keys, no user-controlled properties
      ...(isReadingFiles ? { stdoutEncoding: "binary" as const } : {})
    };
  }
};

function addLineNumbers(
  content: string,
  startLine: number
): { content: string; nextLineNumber: number } {
  const lines = content.split("\n");
  // Don't number the trailing empty line if file ends with newline
  const hasTrailingNewline = content.endsWith("\n");
  const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;

  const numbered = linesToNumber.map((line, i) => {
    const num = String(startLine + i).padStart(6, " ");
    return `${num}\t${line}`;
  });

  return {
    content: numbered.join("\n") + (hasTrailingNewline ? "\n" : ""),
    nextLineNumber: startLine + linesToNumber.length
  };
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "cat",
  flags: [
    { flag: "-n", type: "boolean" },
    { flag: "-A", type: "boolean" },
    { flag: "-b", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-t", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
