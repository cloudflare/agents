import { shellJoinArgs } from "../../helpers/shell-quote";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseDuration } from "../duration";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const timeoutHelp = {
  name: "timeout",
  summary: "run a command with a time limit",
  usage: "timeout [OPTION] DURATION COMMAND [ARG]...",
  description: `Start COMMAND, and kill it if still running after DURATION.

DURATION is a number with optional suffix:
  s - seconds (default)
  m - minutes
  h - hours
  d - days`,
  options: [
    "-k, --kill-after=DURATION  send KILL signal after DURATION if still running",
    "-s, --signal=SIGNAL        specify signal to send (default: TERM)",
    "    --preserve-status      exit with same status as COMMAND, even on timeout",
    "    --foreground           run command in foreground",
    "    --help                 display this help and exit"
  ]
};

export const timeoutCommand: Command = {
  name: "timeout",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(timeoutHelp);
    }

    let commandStart = 0;

    // Parse timeout options
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "--preserve-status") {
        // Accepted but not implemented (always exits 124 on timeout)
        commandStart = i + 1;
      } else if (arg === "--foreground") {
        // Ignored in virtual env
        commandStart = i + 1;
      } else if (arg === "-k" || arg === "--kill-after") {
        // Skip the duration argument
        i++;
        commandStart = i + 1;
      } else if (arg.startsWith("--kill-after=")) {
        commandStart = i + 1;
      } else if (arg === "-s" || arg === "--signal") {
        // Skip the signal argument
        i++;
        commandStart = i + 1;
      } else if (arg.startsWith("--signal=")) {
        commandStart = i + 1;
      } else if (arg.startsWith("--") && arg !== "--") {
        return unknownOption("timeout", arg);
      } else if (arg.startsWith("-") && arg.length > 1 && arg !== "--") {
        // Could be -k or -s with combined value
        if (arg.startsWith("-k")) {
          commandStart = i + 1;
        } else if (arg.startsWith("-s")) {
          commandStart = i + 1;
        } else {
          return unknownOption("timeout", arg);
        }
      } else {
        // First non-option is the duration
        commandStart = i;
        break;
      }
    }

    const remainingArgs = args.slice(commandStart);

    if (remainingArgs.length === 0) {
      return {
        stdout: "",
        stderr: "timeout: missing operand\n",
        exitCode: 1
      };
    }

    // Parse duration
    const durationStr = remainingArgs[0];
    const durationMs = parseDuration(durationStr);

    if (durationMs === null) {
      return {
        stdout: "",
        stderr: `timeout: invalid time interval '${durationStr}'\n`,
        exitCode: 1
      };
    }

    // Get command to execute
    const commandArgs = remainingArgs.slice(1);
    if (commandArgs.length === 0) {
      return {
        stdout: "",
        stderr: "timeout: missing operand\n",
        exitCode: 1
      };
    }

    // Need exec function to run subcommand
    if (!ctx.exec) {
      return {
        stdout: "",
        stderr: "timeout: exec not available\n",
        exitCode: 1
      };
    }

    // Use AbortController for cooperative cancellation.
    // When the timeout fires, the signal is aborted, causing the interpreter
    // to stop at the next statement boundary — no post-timeout side effects.
    const controller = new AbortController();

    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
        timerId = setTimeout(() => {
          controller.abort();
          resolve({ timedOut: true });
        }, durationMs);
      });

      const execPromise = ctx
        .exec(shellJoinArgs([commandArgs[0]]), {
          cwd: ctx.cwd,
          signal: controller.signal,
          stdin: ctx.stdin,
          args: commandArgs.slice(1)
        })
        .then((result) => ({ timedOut: false as const, result }));

      const outcome = await Promise.race([timeoutPromise, execPromise]);

      if (outcome.timedOut) {
        return {
          stdout: "",
          stderr: "",
          exitCode: 124
        };
      }

      return outcome.result;
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "timeout",
  flags: [
    { flag: "-k", type: "value", valueHint: "string" },
    { flag: "-s", type: "value", valueHint: "string" },
    { flag: "--preserve-status", type: "boolean" },
    { flag: "--foreground", type: "boolean" }
  ],
  needsArgs: true,
  minArgs: 2
};
