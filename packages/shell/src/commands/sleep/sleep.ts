import type { Command, CommandContext, ExecResult } from "../../types";
import { parseDuration } from "../duration";
import { hasHelpFlag, showHelp } from "../help";

const sleepHelp = {
  name: "sleep",
  summary: "delay for a specified amount of time",
  usage: "sleep NUMBER[SUFFIX]",
  description: `Pause for NUMBER seconds. SUFFIX may be:
  s - seconds (default)
  m - minutes
  h - hours
  d - days

NUMBER may be a decimal number.`,
  options: ["    --help display this help and exit"]
};

/** Maximum sleep duration: 1 hour (prevents DoS via indefinite blocking) */
const MAX_SLEEP_MS = 3_600_000;

export const sleepCommand: Command = {
  name: "sleep",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(sleepHelp);
    }

    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "sleep: missing operand\n",
        exitCode: 1
      };
    }

    // Parse all arguments and sum durations (like GNU sleep)
    let totalMs = 0;
    for (const arg of args) {
      const ms = parseDuration(arg);
      if (ms === null) {
        return {
          stdout: "",
          stderr: `sleep: invalid time interval '${arg}'\n`,
          exitCode: 1
        };
      }
      totalMs += ms;
    }

    // Cap to prevent indefinite blocking
    if (totalMs > MAX_SLEEP_MS) {
      totalMs = MAX_SLEEP_MS;
    }

    // Check if already aborted before sleeping
    if (ctx.signal?.aborted) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Use mock sleep if available in context, otherwise real setTimeout
    if (ctx.sleep) {
      await ctx.sleep(totalMs);
    } else if (ctx.signal) {
      // Abort-aware sleep: resolve early if the signal fires.
      // Named handler so we can remove it when the timer resolves normally.
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          ctx.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, totalMs);
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, totalMs));
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "sleep",
  flags: [],
  needsArgs: true
};
