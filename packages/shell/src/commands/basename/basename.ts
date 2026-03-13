import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const basenameHelp = {
  name: "basename",
  summary: "strip directory and suffix from filenames",
  usage: "basename NAME [SUFFIX]\nbasename OPTION... NAME...",
  options: [
    "-a, --multiple   support multiple arguments",
    "-s, --suffix=SUFFIX  remove a trailing SUFFIX",
    "    --help       display this help and exit"
  ]
};

export const basenameCommand: Command = {
  name: "basename",

  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(basenameHelp);
    }

    let multiple = false;
    let suffix = "";
    const names: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-a" || arg === "--multiple") {
        multiple = true;
      } else if (arg === "-s" && i + 1 < args.length) {
        suffix = args[++i];
        multiple = true;
      } else if (arg.startsWith("--suffix=")) {
        suffix = arg.slice(9);
        multiple = true;
      } else if (!arg.startsWith("-")) {
        names.push(arg);
      }
    }

    if (names.length === 0) {
      return {
        stdout: "",
        stderr: "basename: missing operand\n",
        exitCode: 1
      };
    }

    // If not multiple mode, second arg is suffix
    if (!multiple && names.length >= 2) {
      suffix = names.pop() ?? "";
    }

    const results: string[] = [];
    for (const name of names) {
      // Remove trailing slashes
      const cleanName = name.replace(/\/+$/, "");
      let base = cleanName.split("/").pop() || cleanName;
      if (suffix && base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length);
      }
      results.push(base);
    }

    return {
      stdout: `${results.join("\n")}\n`,
      stderr: "",
      exitCode: 0
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "basename",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-s", type: "value", valueHint: "string" }
  ],
  needsArgs: true
};
