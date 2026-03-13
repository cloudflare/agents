import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const aliasHelp = {
  name: "alias",
  summary: "define or display aliases",
  usage: "alias [name[=value] ...]",
  options: ["    --help display this help and exit"]
};

// Aliases are stored in the environment
// Format: BASH_ALIASES_<name>=<value>
const ALIAS_PREFIX = "BASH_ALIAS_";

export const aliasCommand: Command = {
  name: "alias",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(aliasHelp);
    }

    // No arguments: list all aliases
    if (args.length === 0) {
      let stdout = "";
      for (const [key, value] of ctx.env) {
        if (key.startsWith(ALIAS_PREFIX)) {
          const name = key.slice(ALIAS_PREFIX.length);
          stdout += `alias ${name}='${value}'\n`;
        }
      }
      return { stdout, stderr: "", exitCode: 0 };
    }

    // Process alias definitions
    // Skip "--" option separator (POSIX standard)
    const processArgs = args[0] === "--" ? args.slice(1) : args;
    for (const arg of processArgs) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx === -1) {
        // Show single alias
        const key = ALIAS_PREFIX + arg;
        if (ctx.env.get(key)) {
          return {
            stdout: `alias ${arg}='${ctx.env.get(key)}'\n`,
            stderr: "",
            exitCode: 0
          };
        } else {
          return {
            stdout: "",
            stderr: `alias: ${arg}: not found\n`,
            exitCode: 1
          };
        }
      } else {
        // Set alias
        const name = arg.slice(0, eqIdx);
        let value = arg.slice(eqIdx + 1);
        // Remove quotes if present
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }
        ctx.env.set(ALIAS_PREFIX + name, value);
      }
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  }
};

export const unaliasCommand: Command = {
  name: "unalias",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp({
        name: "unalias",
        summary: "remove alias definitions",
        usage: "unalias name [name ...]",
        options: [
          "-a      remove all aliases",
          "    --help display this help and exit"
        ]
      });
    }

    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "unalias: usage: unalias [-a] name [name ...]\n",
        exitCode: 1
      };
    }

    // Handle -a to remove all aliases
    if (args[0] === "-a") {
      for (const key of ctx.env.keys()) {
        if (key.startsWith(ALIAS_PREFIX)) {
          ctx.env.delete(key);
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Skip "--" option separator (POSIX standard)
    const processArgs = args[0] === "--" ? args.slice(1) : args;

    let anyError = false;
    let stderr = "";
    for (const name of processArgs) {
      const key = ALIAS_PREFIX + name;
      if (ctx.env.get(key)) {
        ctx.env.delete(key);
      } else {
        stderr += `unalias: ${name}: not found\n`;
        anyError = true;
      }
    }

    return { stdout: "", stderr, exitCode: anyError ? 1 : 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "alias",
  flags: []
};

export const unaliasFlagsForFuzzing: CommandFuzzInfo = {
  name: "unalias",
  flags: [{ flag: "-a", type: "boolean" }]
};
