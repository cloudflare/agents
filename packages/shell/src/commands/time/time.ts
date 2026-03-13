import { sanitizeErrorMessage } from "../../fs/sanitize-error";
import { mapToRecord } from "../../helpers/env";
import { shellJoinArgs } from "../../helpers/shell-quote";
import { _performanceNow } from "../../security/trusted-globals";
import type { Command, CommandContext, ExecResult } from "../../types";

/**
 * time - time command execution
 *
 * Usage: time [-f FORMAT] [-o FILE] [-a] [-v] [-p] command [arguments...]
 *
 * Times the execution of a command and outputs timing statistics.
 *
 * Options:
 *   -f FORMAT    Use FORMAT for output (GNU time format specifiers)
 *   -o FILE      Write timing output to FILE
 *   -a           Append to output file (with -o)
 *   -v           Verbose output
 *   -p           POSIX portable output format
 *
 * Format specifiers:
 *   %e    Elapsed real time in seconds
 *   %M    Maximum resident set size (KB)
 *   %S    System CPU time (seconds)
 *   %U    User CPU time (seconds)
 *
 * Note: In this JavaScript implementation, user/system CPU time and memory
 * metrics are not available, so %M, %S, %U output 0.
 */
export const timeCommand: Command = {
  name: "time",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    // Parse options
    let format = "%e %M"; // Default format
    let outputFile: string | null = null;
    let appendMode = false;
    let posixFormat = false;
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      if (arg === "-f" || arg === "--format") {
        i++;
        if (i >= args.length) {
          return {
            stdout: "",
            stderr: "time: missing argument to '-f'\n",
            exitCode: 1
          };
        }
        format = args[i];
        i++;
      } else if (arg === "-o" || arg === "--output") {
        i++;
        if (i >= args.length) {
          return {
            stdout: "",
            stderr: "time: missing argument to '-o'\n",
            exitCode: 1
          };
        }
        outputFile = args[i];
        i++;
      } else if (arg === "-a" || arg === "--append") {
        appendMode = true;
        i++;
      } else if (arg === "-v" || arg === "--verbose") {
        // Verbose mode - use a detailed format
        format =
          "Command being timed: %C\nElapsed (wall clock) time: %e seconds\nMaximum resident set size (kbytes): %M";
        i++;
      } else if (arg === "-p" || arg === "--portability") {
        posixFormat = true;
        i++;
      } else if (arg === "--") {
        i++;
        break;
      } else if (arg.startsWith("-")) {
        // Unknown option - skip it (be permissive like GNU time)
        i++;
      } else {
        // Start of command
        break;
      }
    }

    // Get the command to time
    const commandArgs = args.slice(i);

    if (commandArgs.length === 0) {
      // No command specified - just return success (matches GNU time behavior)
      return {
        stdout: "",
        stderr: "",
        exitCode: 0
      };
    }

    // Record start time
    const startTime = _performanceNow();

    // Execute the command
    const displayCommand = commandArgs.join(" ");
    let result: ExecResult;

    try {
      if (!ctx.exec) {
        return {
          stdout: "",
          stderr: "time: exec not available\n",
          exitCode: 1
        };
      }
      result = await ctx.exec(shellJoinArgs([commandArgs[0]]), {
        env: mapToRecord(ctx.env),
        cwd: ctx.cwd,
        stdin: ctx.stdin,
        signal: ctx.signal,
        args: commandArgs.slice(1)
      });
    } catch (error) {
      const message = sanitizeErrorMessage((error as Error).message);
      result = {
        stdout: "",
        stderr: `time: ${message}\n`,
        exitCode: 127
      };
    }

    // Record end time
    const endTime = _performanceNow();
    const elapsedSeconds = (endTime - startTime) / 1000;

    // Format the timing output
    let timingOutput: string;

    if (posixFormat) {
      // POSIX format: real, user, sys
      timingOutput = `real ${elapsedSeconds.toFixed(2)}\nuser 0.00\nsys 0.00\n`;
    } else {
      // Apply format specifiers
      timingOutput = format
        .replace(/%e/g, elapsedSeconds.toFixed(2))
        .replace(/%E/g, formatElapsedTime(elapsedSeconds))
        .replace(/%M/g, "0") // Max resident set size - not available in JS
        .replace(/%S/g, "0.00") // System CPU time - not available in JS
        .replace(/%U/g, "0.00") // User CPU time - not available in JS
        .replace(/%P/g, "0%") // CPU percentage - not available in JS
        .replace(/%C/g, displayCommand); // Command being timed

      // Add newline if not present
      if (!timingOutput.endsWith("\n")) {
        timingOutput += "\n";
      }
    }

    // Output timing info
    if (outputFile) {
      // Write to file
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, outputFile);
        if (appendMode && (await ctx.fs.exists(filePath))) {
          const existing = await ctx.fs.readFile(filePath);
          await ctx.fs.writeFile(filePath, existing + timingOutput);
        } else {
          await ctx.fs.writeFile(filePath, timingOutput);
        }
      } catch (error) {
        const message = sanitizeErrorMessage((error as Error).message);
        return {
          stdout: result.stdout,
          stderr:
            result.stderr +
            `time: cannot write to '${outputFile}': ${message}\n`,
          exitCode: result.exitCode
        };
      }
    } else {
      // Output to stderr (standard behavior for time)
      result = {
        ...result,
        stderr: result.stderr + timingOutput
      };
    }

    return result;
  }
};

/**
 * Format elapsed time in [hours:]minutes:seconds format
 */
function formatElapsedTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
  }
  return `${minutes}:${secs.toFixed(2).padStart(5, "0")}`;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "time",
  flags: [{ flag: "-p", type: "boolean" }],
  needsArgs: true
};
