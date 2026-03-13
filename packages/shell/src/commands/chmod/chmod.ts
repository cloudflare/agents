import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const chmodHelp = {
  name: "chmod",
  summary: "change file mode bits",
  usage: "chmod [OPTIONS] MODE FILE...",
  options: [
    "-R      change files recursively",
    "-v      output a diagnostic for every file processed",
    "    --help display this help and exit"
  ]
};

export const chmodCommand: Command = {
  name: "chmod",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(chmodHelp);
    }

    if (args.length < 2) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }

    let recursive = false;
    let verbose = false;
    let argIdx = 0;

    // Parse options
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-R" || arg === "--recursive") {
        recursive = true;
        argIdx++;
      } else if (arg === "-v" || arg === "--verbose") {
        verbose = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        // Mode might start with - for removing permissions, check if it looks like a mode
        if (/^[+-]?[rwxugo]+/.test(arg) || /^\d+$/.test(arg)) {
          break;
        }
        // Check for combined flags like -Rv
        if (/^-[Rv]+$/.test(arg)) {
          if (arg.includes("R")) recursive = true;
          if (arg.includes("v")) verbose = true;
          argIdx++;
          continue;
        }
        return unknownOption("chmod", arg);
      }
    }

    if (args.length - argIdx < 2) {
      return { stdout: "", stderr: "chmod: missing operand\n", exitCode: 1 };
    }

    const modeArg = args[argIdx];
    const files = args.slice(argIdx + 1);

    // Check if mode is numeric or symbolic
    const isNumericMode = /^[0-7]+$/.test(modeArg);

    // Validate and parse mode
    let numericMode: number | undefined;
    if (isNumericMode) {
      numericMode = parseInt(modeArg, 8);
    } else {
      // Validate symbolic mode syntax before applying
      try {
        // Use a dummy mode to validate syntax
        parseMode(modeArg, 0o644);
      } catch {
        return {
          stdout: "",
          stderr: `chmod: invalid mode: '${modeArg}'\n`,
          exitCode: 1
        };
      }
    }

    let stdout = "";
    let stderr = "";
    let anyError = false;

    for (const file of files) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      try {
        // For symbolic mode, we need to read the current mode first
        let modeValue: number;
        if (isNumericMode && numericMode !== undefined) {
          modeValue = numericMode;
        } else {
          const stat = await ctx.fs.stat(filePath);
          modeValue = parseMode(modeArg, stat.mode);
        }

        await ctx.fs.chmod(filePath, modeValue);
        if (verbose) {
          stdout += `mode of '${file}' changed to ${modeValue.toString(8).padStart(4, "0")}\n`;
        }

        if (recursive) {
          // Check if directory
          const stat = await ctx.fs.stat(filePath);
          if (stat.isDirectory) {
            const recursiveOutput = await chmodRecursive(
              ctx,
              filePath,
              isNumericMode ? numericMode : undefined,
              isNumericMode ? undefined : modeArg,
              verbose
            );
            stdout += recursiveOutput;
          }
        }
      } catch {
        stderr += `chmod: cannot access '${file}': No such file or directory\n`;
        anyError = true;
      }
    }

    return { stdout, stderr, exitCode: anyError ? 1 : 0 };
  }
};

async function chmodRecursive(
  ctx: CommandContext,
  dir: string,
  numericMode: number | undefined,
  symbolicMode: string | undefined,
  verbose: boolean
): Promise<string> {
  let output = "";
  const entries = await ctx.fs.readdir(dir);
  for (const entry of entries) {
    const fullPath = dir === "/" ? `/${entry}` : `${dir}/${entry}`;

    // Calculate mode value
    let modeValue: number;
    if (numericMode !== undefined) {
      modeValue = numericMode;
    } else if (symbolicMode !== undefined) {
      const stat = await ctx.fs.stat(fullPath);
      modeValue = parseMode(symbolicMode, stat.mode);
    } else {
      // Should not happen, but fallback to 0644
      modeValue = 0o644;
    }

    await ctx.fs.chmod(fullPath, modeValue);
    if (verbose) {
      output += `mode of '${fullPath}' changed to ${modeValue.toString(8).padStart(4, "0")}\n`;
    }

    const stat = await ctx.fs.stat(fullPath);
    if (stat.isDirectory) {
      output += await chmodRecursive(
        ctx,
        fullPath,
        numericMode,
        symbolicMode,
        verbose
      );
    }
  }
  return output;
}

/**
 * Parse a mode string and return the resulting mode value.
 * For numeric modes, currentMode is ignored.
 * For symbolic modes, currentMode is used as the starting point.
 */
function parseMode(modeStr: string, currentMode = 0o644): number {
  // Numeric mode (octal)
  if (/^[0-7]+$/.test(modeStr)) {
    return parseInt(modeStr, 8);
  }

  // Symbolic mode - start with current mode
  let mode = currentMode & 0o7777; // Only keep permission bits

  // Parse symbolic modes like u+x, g-w, o=r, a+x, +x
  const parts = modeStr.split(",");
  for (const part of parts) {
    const match = part.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/);
    if (!match) {
      throw new Error(`Invalid mode: ${modeStr}`);
    }

    let who = match[1] || "a";
    const op = match[2];
    const perms = match[3];

    // Convert 'a' to 'ugo'
    if (who === "a" || who === "") {
      who = "ugo";
    }

    let permBits = 0;
    if (perms.includes("r")) permBits |= 0o4;
    if (perms.includes("w")) permBits |= 0o2;
    if (perms.includes("x") || perms.includes("X")) permBits |= 0o1;

    // Handle special bits (s for setuid/setgid, t for sticky)
    let specialBits = 0;
    if (perms.includes("s")) {
      // s sets setuid (4000) when applied to user, setgid (2000) when applied to group
      if (who.includes("u")) specialBits |= 0o4000;
      if (who.includes("g")) specialBits |= 0o2000;
    }
    if (perms.includes("t")) {
      // t sets sticky bit (1000) - only meaningful for "other" but can be set via any who
      specialBits |= 0o1000;
    }

    for (const w of who) {
      let shift = 0;
      if (w === "u") shift = 6;
      else if (w === "g") shift = 3;
      else if (w === "o") shift = 0;

      const bits = permBits << shift;

      if (op === "+") {
        mode |= bits;
      } else if (op === "-") {
        mode &= ~bits;
      } else if (op === "=") {
        // Clear the bits for this who, then set
        mode &= ~(0o7 << shift);
        mode |= bits;
      }
    }

    // Apply special bits
    if (op === "+") {
      mode |= specialBits;
    } else if (op === "-") {
      mode &= ~specialBits;
    } else if (op === "=") {
      // For =, clear and set the special bits if specified
      if (perms.includes("s")) {
        if (who.includes("u")) {
          mode &= ~0o4000;
          mode |= specialBits & 0o4000;
        }
        if (who.includes("g")) {
          mode &= ~0o2000;
          mode |= specialBits & 0o2000;
        }
      }
      if (perms.includes("t")) {
        mode &= ~0o1000;
        mode |= specialBits & 0o1000;
      }
    }
  }

  return mode;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "chmod",
  flags: [
    { flag: "-R", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  needsArgs: true,
  minArgs: 2
};
