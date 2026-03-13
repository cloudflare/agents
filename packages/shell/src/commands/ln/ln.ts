import { sanitizeErrorMessage } from "../../fs/sanitize-error";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const lnHelp = {
  name: "ln",
  summary: "make links between files",
  usage: "ln [OPTIONS] TARGET LINK_NAME",
  options: [
    "-s      create a symbolic link instead of a hard link",
    "-f      remove existing destination files",
    "-n      treat LINK_NAME as a normal file if it is a symbolic link to a directory",
    "-v      print name of each linked file",
    "    --help display this help and exit"
  ]
};

export const lnCommand: Command = {
  name: "ln",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(lnHelp);
    }

    let symbolic = false;
    let force = false;
    let verbose = false;
    let argIdx = 0;

    // Parse options
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-s" || arg === "--symbolic") {
        symbolic = true;
        argIdx++;
      } else if (arg === "-f" || arg === "--force") {
        force = true;
        argIdx++;
      } else if (arg === "-v" || arg === "--verbose") {
        verbose = true;
        argIdx++;
      } else if (arg === "-n" || arg === "--no-dereference") {
        // For now, just accept the flag but don't implement special behavior
        argIdx++;
      } else if (/^-[sfvn]+$/.test(arg)) {
        // Combined short flags like -sf, -sfv, etc.
        if (arg.includes("s")) symbolic = true;
        if (arg.includes("f")) force = true;
        if (arg.includes("v")) verbose = true;
        // -n is accepted but not implemented
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        return unknownOption("ln", arg);
      }
    }

    const remaining = args.slice(argIdx);

    if (remaining.length < 2) {
      return { stdout: "", stderr: "ln: missing file operand\n", exitCode: 1 };
    }

    const target = remaining[0];
    const linkName = remaining[1];
    const linkPath = ctx.fs.resolvePath(ctx.cwd, linkName);

    // Check if link already exists
    if (await ctx.fs.exists(linkPath)) {
      if (force) {
        try {
          await ctx.fs.rm(linkPath, { force: true });
        } catch {
          return {
            stdout: "",
            stderr: `ln: cannot remove '${linkName}': Permission denied\n`,
            exitCode: 1
          };
        }
      } else {
        return {
          stdout: "",
          stderr: `ln: failed to create ${symbolic ? "symbolic " : ""}link '${linkName}': File exists\n`,
          exitCode: 1
        };
      }
    }

    try {
      if (symbolic) {
        // Create symbolic link
        // For symlinks, the target is stored as-is (can be relative or absolute)
        await ctx.fs.symlink(target, linkPath);
      } else {
        // Create hard link
        const targetPath = ctx.fs.resolvePath(ctx.cwd, target);
        // Check that target exists
        if (!(await ctx.fs.exists(targetPath))) {
          return {
            stdout: "",
            stderr: `ln: failed to access '${target}': No such file or directory\n`,
            exitCode: 1
          };
        }
        await ctx.fs.link(targetPath, linkPath);
      }
    } catch (e) {
      const err = e as Error;
      if (err.message.includes("EPERM")) {
        return {
          stdout: "",
          stderr: `ln: '${target}': hard link not allowed for directory\n`,
          exitCode: 1
        };
      }
      const message = sanitizeErrorMessage(err.message);
      return { stdout: "", stderr: `ln: ${message}\n`, exitCode: 1 };
    }

    let stdout = "";
    if (verbose) {
      stdout = `'${linkName}' -> '${target}'\n`;
    }
    return { stdout, stderr: "", exitCode: 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "ln",
  flags: [
    { flag: "-s", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  needsArgs: true,
  minArgs: 2
};
