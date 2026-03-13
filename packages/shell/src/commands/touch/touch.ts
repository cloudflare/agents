import { getErrorMessage } from "../../interpreter/helpers/errors";
import type { Command, CommandContext, ExecResult } from "../../types";
import { unknownOption } from "../help";

/**
 * Parse a date string in various formats supported by touch -d
 * Supports:
 * - YYYY/MM/DD or YYYY-MM-DD
 * - YYYY/MM/DD HH:MM:SS or YYYY-MM-DD HH:MM:SS
 * - ISO 8601 format
 */
function parseDateString(dateStr: string): Date | null {
  // Try common date formats
  // Replace / with - for consistency
  const normalized = dateStr.replace(/\//g, "-");

  // Try parsing as ISO 8601 or simple date
  let date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }

  // Try YYYY-MM-DD format (Date constructor may interpret as UTC)
  const dateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    date = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10)
    );
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  // Try YYYY-MM-DD HH:MM:SS format
  const dateTimeMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/
  );
  if (dateTimeMatch) {
    const [, year, month, day, hour, minute, second] = dateTimeMatch;
    date = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10)
    );
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

export const touchCommand: Command = {
  name: "touch",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const files: string[] = [];
    let dateStr: string | null = null;
    let noCreate = false;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "--") {
        // Rest are files
        files.push(...args.slice(i + 1));
        break;
      } else if (arg === "-d" || arg === "--date") {
        // -d DATE or --date=DATE
        if (i + 1 >= args.length) {
          return {
            stdout: "",
            stderr: "touch: option requires an argument -- 'd'\n",
            exitCode: 1
          };
        }
        dateStr = args[++i];
      } else if (arg.startsWith("--date=")) {
        dateStr = arg.slice("--date=".length);
      } else if (arg === "-c" || arg === "--no-create") {
        noCreate = true;
      } else if (arg === "-a" || arg === "-m" || arg === "-r" || arg === "-t") {
        // Silently ignore -a (access time only), -m (modify time only),
        // -r (reference file), -t (timestamp format) for now
        if (arg === "-r" || arg === "-t") {
          // These take an argument
          i++;
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("touch", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        // Check for combined short options like -cm
        let skipNext = false;
        for (const char of arg.slice(1)) {
          if (char === "c") {
            noCreate = true;
          } else if (char === "a" || char === "m") {
            // Silently ignore
          } else if (char === "d") {
            // -d requires next argument
            if (i + 1 >= args.length) {
              return {
                stdout: "",
                stderr: "touch: option requires an argument -- 'd'\n",
                exitCode: 1
              };
            }
            dateStr = args[++i];
            skipNext = true;
            break;
          } else if (char === "r" || char === "t") {
            // Skip next argument
            i++;
            skipNext = true;
            break;
          } else {
            return unknownOption("touch", `-${char}`);
          }
        }
        if (skipNext) continue;
      } else {
        files.push(arg);
      }
    }

    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "touch: missing file operand\n",
        exitCode: 1
      };
    }

    // Parse the date if provided
    let targetTime: Date | null = null;
    if (dateStr !== null) {
      targetTime = parseDateString(dateStr);
      if (targetTime === null) {
        return {
          stdout: "",
          stderr: `touch: invalid date format '${dateStr}'\n`,
          exitCode: 1
        };
      }
    }

    let stderr = "";
    let exitCode = 0;

    for (const file of files) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
        const exists = await ctx.fs.exists(fullPath);

        if (!exists) {
          if (noCreate) {
            // -c: don't create, just skip
            continue;
          }
          await ctx.fs.writeFile(fullPath, "");
        }

        // Update timestamp if we have utimes support
        const mtime = targetTime ?? new Date();
        await ctx.fs.utimes(fullPath, mtime, mtime);
      } catch (error) {
        stderr += `touch: cannot touch '${file}': ${getErrorMessage(error)}\n`;
        exitCode = 1;
      }
    }

    return { stdout: "", stderr, exitCode };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "touch",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-a", type: "boolean" },
    { flag: "-m", type: "boolean" },
    { flag: "-d", type: "value", valueHint: "string" }
  ],
  needsArgs: true
};
