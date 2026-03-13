import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const readlinkHelp = {
  name: "readlink",
  summary: "print resolved symbolic links or canonical file names",
  usage: "readlink [OPTIONS] FILE...",
  options: [
    "-f      canonicalize by following every symlink in every component of the given name recursively",
    "    --help display this help and exit"
  ]
};

export const readlinkCommand: Command = {
  name: "readlink",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(readlinkHelp);
    }

    let canonicalize = false;
    let argIdx = 0;

    // Parse options
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-f" || arg === "--canonicalize") {
        canonicalize = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        return unknownOption("readlink", arg);
      }
    }

    const files = args.slice(argIdx);

    if (files.length === 0) {
      return { stdout: "", stderr: "readlink: missing operand\n", exitCode: 1 };
    }

    let stdout = "";
    let anyError = false;

    for (const file of files) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);

      try {
        if (canonicalize) {
          // For -f, resolve the full path following all symlinks
          let currentPath = filePath;
          const seen = new Set<string>();

          while (true) {
            if (seen.has(currentPath)) {
              // Circular symlink detected
              break;
            }
            seen.add(currentPath);

            try {
              const target = await ctx.fs.readlink(currentPath);
              // If target is relative, resolve from current path's directory
              if (target.startsWith("/")) {
                currentPath = target;
              } else {
                const dir =
                  currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
                currentPath = ctx.fs.resolvePath(dir, target);
              }
            } catch {
              // Not a symlink or doesn't exist - we've reached the end
              break;
            }
          }
          stdout += `${currentPath}\n`;
        } else {
          // Without -f, just read the symlink target
          const target = await ctx.fs.readlink(filePath);
          stdout += `${target}\n`;
        }
      } catch {
        if (!canonicalize) {
          // Only error for non-canonicalize mode on non-symlinks
          anyError = true;
        } else {
          // For -f mode, return the resolved path even if not a symlink
          stdout += `${filePath}\n`;
        }
      }
    }

    return { stdout, stderr: "", exitCode: anyError ? 1 : 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "readlink",
  flags: [
    { flag: "-f", type: "boolean" },
    { flag: "-e", type: "boolean" }
  ],
  needsArgs: true
};
