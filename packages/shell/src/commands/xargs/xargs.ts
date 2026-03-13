import { shellJoinArgs } from "../../helpers/shell-quote";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const xargsHelp = {
  name: "xargs",
  summary: "build and execute command lines from standard input",
  usage: "xargs [OPTION]... [COMMAND [INITIAL-ARGS]]",
  options: [
    "-I REPLACE   replace occurrences of REPLACE with input",
    "-d DELIM     use DELIM as input delimiter (e.g., -d '\\n' for newline)",
    "-n NUM       use at most NUM arguments per command line",
    "-P NUM       run at most NUM processes at a time",
    "-0, --null   items are separated by null, not whitespace",
    "-t, --verbose  print commands before executing",
    "-r, --no-run-if-empty  do not run command if input is empty",
    "    --help   display this help and exit"
  ]
};

export const xargsCommand: Command = {
  name: "xargs",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(xargsHelp);
    }

    let replaceStr: string | null = null;
    let delimiter: string | null = null;
    let maxArgs: number | null = null;
    let maxProcs: number | null = null;
    let nullSeparator = false;
    let verbose = false;
    let noRunIfEmpty = false;
    let commandStart = 0;

    // Parse xargs options
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-I" && i + 1 < args.length) {
        replaceStr = args[++i];
        commandStart = i + 1;
      } else if (arg === "-d" && i + 1 < args.length) {
        // Parse delimiter - handle escape sequences like \n, \t
        const delimArg = args[++i];
        delimiter = delimArg
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\0/g, "\0")
          .replace(/\\\\/g, "\\");
        commandStart = i + 1;
      } else if (arg === "-n" && i + 1 < args.length) {
        maxArgs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === "-P" && i + 1 < args.length) {
        maxProcs = parseInt(args[++i], 10);
        commandStart = i + 1;
      } else if (arg === "-0" || arg === "--null") {
        nullSeparator = true;
        commandStart = i + 1;
      } else if (arg === "-t" || arg === "--verbose") {
        verbose = true;
        commandStart = i + 1;
      } else if (arg === "-r" || arg === "--no-run-if-empty") {
        noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (arg.startsWith("--")) {
        return unknownOption("xargs", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        // Check for unknown short options (only boolean flags allowed in combined form)
        for (const c of arg.slice(1)) {
          if (!"0tr".includes(c)) {
            return unknownOption("xargs", `-${c}`);
          }
        }
        // Handle combined short options
        if (arg.includes("0")) nullSeparator = true;
        if (arg.includes("t")) verbose = true;
        if (arg.includes("r")) noRunIfEmpty = true;
        commandStart = i + 1;
      } else if (!arg.startsWith("-")) {
        commandStart = i;
        break;
      }
    }

    // Get command and initial args
    const command = args.slice(commandStart);
    if (command.length === 0) {
      command.push("echo");
    }

    // Parse input
    // Priority: -0 (null) > -d (custom delimiter) > default (whitespace)
    let items: string[];
    if (nullSeparator) {
      items = ctx.stdin.split("\0").filter((s) => s.length > 0);
    } else if (delimiter !== null) {
      // Custom delimiter - split on exact string
      // Strip trailing newline from input before splitting (echo adds trailing newlines)
      const input = ctx.stdin.replace(/\n$/, "");
      items = input.split(delimiter).filter((s) => s.length > 0);
    } else {
      // Default: split on whitespace and trim
      items = ctx.stdin
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    if (items.length === 0) {
      if (noRunIfEmpty) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // With no -r flag, still run the command with no args
      // (echo with no args just outputs newline)
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Execute commands
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    // Helper to quote an argument if it contains special characters
    const quoteArg = (arg: string): string => {
      // If arg contains spaces, quotes, or shell metacharacters, quote it
      // Note: \s includes spaces, tabs, and newlines
      if (/[\s"'\\$`!*?[\]{}();&|<>#]/.test(arg)) {
        // Use double quotes and escape characters that are special inside double quotes:
        // backslash, double quote, dollar sign, and backtick
        return `"${arg.replace(/([\\"`$])/g, "\\$1")}"`;
      }
      return arg;
    };

    // Helper to execute a single command via the shell
    const executeCommand = async (cmdArgs: string[]): Promise<ExecResult> => {
      if (verbose) {
        const cmdLine = cmdArgs.map(quoteArg).join(" ");
        stderr += `${cmdLine}\n`;
      }
      // Use ctx.exec to run the command, passing current working directory
      if (ctx.exec) {
        return ctx.exec(shellJoinArgs([cmdArgs[0]]), {
          cwd: ctx.cwd,
          signal: ctx.signal,
          args: cmdArgs.slice(1)
        });
      }
      // Fallback: just output what would be run
      const cmdLine = cmdArgs.map(quoteArg).join(" ");
      return { stdout: `${cmdLine}\n`, stderr: "", exitCode: 0 };
    };

    // Helper to run commands with optional parallelism
    const runCommands = async (cmdArgsList: string[][]): Promise<void> => {
      if (maxProcs !== null && maxProcs > 1) {
        // Run in parallel batches
        for (let i = 0; i < cmdArgsList.length; i += maxProcs) {
          const batch = cmdArgsList.slice(i, i + maxProcs);
          const results = await Promise.all(batch.map(executeCommand));
          for (const result of results) {
            stdout += result.stdout;
            stderr += result.stderr;
            if (result.exitCode !== 0) {
              exitCode = result.exitCode;
            }
          }
        }
      } else {
        // Sequential execution
        for (const cmdArgs of cmdArgsList) {
          const result = await executeCommand(cmdArgs);
          stdout += result.stdout;
          stderr += result.stderr;
          if (result.exitCode !== 0) {
            exitCode = result.exitCode;
          }
        }
      }
    };

    if (replaceStr !== null) {
      // -I mode: run command once per item, replacing replaceStr in each argument
      const cmdArgsList = items.map((item) =>
        command.map((c) => c.replaceAll(replaceStr, item))
      );
      await runCommands(cmdArgsList);
    } else if (maxArgs !== null) {
      // -n mode: batch items
      const cmdArgsList: string[][] = [];
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs);
        cmdArgsList.push([...command, ...batch]);
      }
      await runCommands(cmdArgsList);
    } else {
      // Default: all items on one line
      const cmdArgs = [...command, ...items];
      const result = await executeCommand(cmdArgs);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
    }

    return { stdout, stderr, exitCode };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "xargs",
  flags: [
    { flag: "-I", type: "value", valueHint: "string" },
    { flag: "-d", type: "value", valueHint: "delimiter" },
    { flag: "-n", type: "value", valueHint: "number" },
    { flag: "-0", type: "boolean" },
    { flag: "-t", type: "boolean" },
    { flag: "-r", type: "boolean" }
  ],
  stdinType: "text"
};
