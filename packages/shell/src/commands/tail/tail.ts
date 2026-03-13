import type { Command, CommandContext, ExecResult } from "../../types";
import {
  getTail,
  parseHeadTailArgs,
  processHeadTailFiles
} from "../head/head-tail-shared";
import { hasHelpFlag, showHelp } from "../help";

const tailHelp = {
  name: "tail",
  summary: "output the last part of files",
  usage: "tail [OPTION]... [FILE]...",
  options: [
    "-c, --bytes=NUM    print the last NUM bytes",
    "-n, --lines=NUM    print the last NUM lines (default 10)",
    "-n +NUM            print starting from line NUM",
    "-q, --quiet        never print headers giving file names",
    "-v, --verbose      always print headers giving file names",
    "    --help         display this help and exit"
  ]
};

export const tailCommand: Command = {
  name: "tail",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(tailHelp);
    }

    const parsed = parseHeadTailArgs(args, "tail");
    if (!parsed.ok) {
      return parsed.error;
    }

    const { lines, bytes, fromLine } = parsed.options;

    return processHeadTailFiles(ctx, parsed.options, "tail", (content) =>
      getTail(content, lines, bytes, fromLine ?? false)
    );
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tail",
  flags: [
    { flag: "-n", type: "value", valueHint: "number" },
    { flag: "-c", type: "value", valueHint: "number" },
    { flag: "-q", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
