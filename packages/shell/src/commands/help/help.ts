import { shellJoinArgs } from "../../helpers/shell-quote";
import type { Command, CommandContext, ExecResult } from "../../types";

// Command categories for organized display
const CATEGORIES = new Map<string, string[]>([
  [
    "File operations",
    [
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "touch",
      "mkdir",
      "rm",
      "cp",
      "mv",
      "ln",
      "chmod",
      "stat",
      "readlink"
    ]
  ],
  [
    "Text processing",
    ["grep", "sed", "awk", "sort", "uniq", "cut", "tr", "tee", "diff"]
  ],
  ["Search", ["find"]],
  ["Navigation & paths", ["pwd", "basename", "dirname", "tree", "du"]],
  [
    "Environment & shell",
    [
      "echo",
      "printf",
      "env",
      "printenv",
      "export",
      "alias",
      "unalias",
      "history",
      "clear",
      "true",
      "false",
      "bash",
      "sh"
    ]
  ],
  ["Data processing", ["xargs", "jq", "base64", "date"]],
  ["Network", ["curl", "html-to-markdown"]]
]);

function formatHelp(commands: string[]): string {
  const lines: string[] = [];
  const commandSet = new Set(commands);

  lines.push("Available commands:\n");

  // Group commands by category
  const uncategorized: string[] = [];

  for (const [category, cmds] of CATEGORIES) {
    const available = cmds.filter((c) => commandSet.has(c));
    if (available.length > 0) {
      lines.push(`  ${category}:`);
      lines.push(`    ${available.join(", ")}\n`);
      for (const c of available) {
        commandSet.delete(c);
      }
    }
  }

  // Any remaining commands not in categories
  for (const cmd of commandSet) {
    uncategorized.push(cmd);
  }
  if (uncategorized.length > 0) {
    lines.push("  Other:");
    lines.push(`    ${uncategorized.sort().join(", ")}\n`);
  }

  lines.push("Use '<command> --help' for details on a specific command.");

  return `${lines.join("\n")}\n`;
}

export const helpCommand: Command = {
  name: "help",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    // Handle --help
    if (args.includes("--help") || args.includes("-h")) {
      return {
        stdout: `help - display available commands

Usage: help [command]

Options:
  -h, --help    Show this help message

If a command name is provided, shows help for that command.
Otherwise, lists all available commands.
`,
        stderr: "",
        exitCode: 0
      };
    }

    // If a command name is provided, delegate to that command's --help
    if (args.length > 0 && ctx.exec) {
      const cmdName = args[0];
      // Shell-quote the command name since it comes from user input
      // and could contain metacharacters
      return ctx.exec(shellJoinArgs([cmdName]), {
        cwd: ctx.cwd,
        signal: ctx.signal,
        args: ["--help"]
      });
    }

    // List all available commands
    const commands = ctx.getRegisteredCommands?.() ?? [];
    return {
      stdout: formatHelp(commands),
      stderr: "",
      exitCode: 0
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "help",
  flags: []
};
