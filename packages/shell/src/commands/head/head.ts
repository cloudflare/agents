import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";
import {
  getHead,
  parseHeadTailArgs,
  processHeadTailFiles
} from "./head-tail-shared";

const headHelp = {
  name: "head",
  summary: "output the first part of files",
  usage: "head [OPTION]... [FILE]...",
  options: [
    "-c, --bytes=NUM    print the first NUM bytes",
    "-n, --lines=NUM    print the first NUM lines (default 10)",
    "-q, --quiet        never print headers giving file names",
    "-v, --verbose      always print headers giving file names",
    "    --help         display this help and exit"
  ]
};

export const headCommand: Command = {
  name: "head",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(headHelp);
    }

    const parsed = parseHeadTailArgs(args, "head");
    if (!parsed.ok) {
      return parsed.error;
    }

    const { lines, bytes } = parsed.options;

    return processHeadTailFiles(ctx, parsed.options, "head", (content) =>
      getHead(content, lines, bytes)
    );
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "head",
  flags: [
    { flag: "-n", type: "value", valueHint: "number" },
    { flag: "-c", type: "value", valueHint: "number" },
    { flag: "-q", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  stdinType: "text",
  needsFiles: true
};
