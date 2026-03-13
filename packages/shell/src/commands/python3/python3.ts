/**
 * python3 / python commands - Interface-backed code execution
 *
 * When a CodeExecutor is provided via ShellOptions.executor, these commands
 * enable Python execution in the shell.
 */

import type { CodeExecutor } from "../../interfaces";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const python3Help = {
  name: "python3",
  summary: "execute Python code via pluggable CodeExecutor",
  usage: "python3 [-c CODE] [FILE]",
  options: [
    "-c CODE   execute CODE as a Python script",
    "    --help display this help and exit"
  ]
};

/**
 * Create a python3 command backed by a CodeExecutor interface.
 */
export function createPython3Command(executor: CodeExecutor): Command {
  return {
    name: "python3",
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (hasHelpFlag(args)) {
        return showHelp(python3Help);
      }

      let code = "";

      if (args.length >= 2 && args[0] === "-c") {
        code = args.slice(1).join(" ");
      } else if (args.length === 1 && args[0] !== "-c") {
        // Read script from file
        try {
          const filePath = ctx.fs.resolvePath(ctx.cwd, args[0]);
          code = await ctx.fs.readFile(filePath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            stdout: "",
            stderr: `python3: can't open file '${args[0]}': ${msg}\n`,
            exitCode: 2
          };
        }
      } else if (args.length === 0) {
        code = ctx.stdin.trim();
      }

      if (!code) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      try {
        const env: Record<string, string> = {};
        for (const [k, v] of ctx.env) {
          env[k] = v;
        }
        const result = await executor.execute(code, "python", {
          stdin: ctx.stdin,
          env
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          stdout: "",
          stderr: `python3: ${msg}\n`,
          exitCode: 1
        };
      }
    }
  };
}

/**
 * Create a python command (alias for python3) backed by a CodeExecutor interface.
 */
export function createPythonCommand(executor: CodeExecutor): Command {
  const py3 = createPython3Command(executor);
  return {
    name: "python",
    execute: py3.execute
  };
}
