import { getErrorMessage } from "../../interpreter/helpers/errors";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const cpHelp = {
  name: "cp",
  summary: "copy files and directories",
  usage: "cp [OPTION]... SOURCE... DEST",
  options: [
    "-r, -R, --recursive  copy directories recursively",
    "-n, --no-clobber     do not overwrite an existing file",
    "-p, --preserve       preserve file attributes",
    "-v, --verbose        explain what is being done",
    "    --help           display this help and exit"
  ]
};

const argDefs = {
  recursive: { short: "r", long: "recursive", type: "boolean" as const },
  recursiveUpper: { short: "R", type: "boolean" as const },
  noClobber: { short: "n", long: "no-clobber", type: "boolean" as const },
  preserve: { short: "p", long: "preserve", type: "boolean" as const },
  verbose: { short: "v", long: "verbose", type: "boolean" as const }
};

export const cpCommand: Command = {
  name: "cp",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(cpHelp);
    }

    const parsed = parseArgs("cp", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const recursive =
      parsed.result.flags.recursive || parsed.result.flags.recursiveUpper;
    const noClobber = parsed.result.flags.noClobber;
    const preserve = parsed.result.flags.preserve;
    const verbose = parsed.result.flags.verbose;
    const paths = parsed.result.positional;

    if (paths.length < 2) {
      return {
        stdout: "",
        stderr: "cp: missing destination file operand\n",
        exitCode: 1
      };
    }

    const dest = paths.pop() ?? "";
    const sources = paths;
    const destPath = ctx.fs.resolvePath(ctx.cwd, dest);

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    // Check if dest is a directory
    let destIsDir = false;
    try {
      const stat = await ctx.fs.stat(destPath);
      destIsDir = stat.isDirectory;
    } catch {
      // Dest doesn't exist
    }

    // If multiple sources, dest must be a directory
    if (sources.length > 1 && !destIsDir) {
      return {
        stdout: "",
        stderr: `cp: target '${dest}' is not a directory\n`,
        exitCode: 1
      };
    }

    for (const src of sources) {
      try {
        const srcPath = ctx.fs.resolvePath(ctx.cwd, src);
        const srcStat = await ctx.fs.stat(srcPath);

        let targetPath = destPath;
        if (destIsDir) {
          const basename = src.split("/").pop() || src;
          targetPath =
            destPath === "/" ? `/${basename}` : `${destPath}/${basename}`;
        }

        if (srcStat.isDirectory && !recursive) {
          stderr += `cp: -r not specified; omitting directory '${src}'\n`;
          exitCode = 1;
          continue;
        }

        // Check for no-clobber: skip if target exists
        if (noClobber) {
          try {
            await ctx.fs.stat(targetPath);
            // Target exists, skip silently
            continue;
          } catch {
            // Target doesn't exist, proceed with copy
          }
        }

        await ctx.fs.cp(srcPath, targetPath, { recursive });

        // Note: preserve flag is accepted but timestamps are not actually preserved
        // in the virtual filesystem (the fs.cp doesn't support preserving metadata)
        if (preserve) {
          // Silently accepted - would preserve timestamps in real implementation
        }

        if (verbose) {
          stdout += `'${src}' -> '${targetPath}'\n`;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          stderr += `cp: cannot stat '${src}': No such file or directory\n`;
        } else {
          stderr += `cp: cannot copy '${src}': ${message}\n`;
        }
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "cp",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-R", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-p", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  needsArgs: true,
  minArgs: 2
};
