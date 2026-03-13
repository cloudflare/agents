/**
 * js-exec / node commands - Interface-backed code execution
 *
 * When a CodeExecutor is provided via ShellOptions.executor, these commands
 * enable JavaScript execution in the shell.
 */

import type { CodeExecutor } from "../../interfaces";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const jsExecHelp = {
  name: "js-exec",
  summary: "execute JavaScript code via pluggable CodeExecutor",
  usage: "js-exec [CODE]",
  options: ["    --help    display this help and exit"]
};

/**
 * Create a js-exec command backed by a CodeExecutor interface.
 */
export function createJsExecCommand(executor: CodeExecutor): Command {
  return {
    name: "js-exec",
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (hasHelpFlag(args)) {
        return showHelp(jsExecHelp);
      }

      const code = args.join(" ").trim() || ctx.stdin.trim();
      if (!code) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      try {
        const env: Record<string, string> = {};
        for (const [k, v] of ctx.env) {
          env[k] = v;
        }
        const result = await executor.execute(code, "javascript", {
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
          stderr: `js-exec: ${msg}\n`,
          exitCode: 1
        };
      }
    }
  };
}

/**
 * Create a node command (alias for js-exec) backed by a CodeExecutor interface.
 */
export function createNodeCommand(executor: CodeExecutor): Command {
  const jsExec = createJsExecCommand(executor);
  return {
    name: "node",
    execute: jsExec.execute
  };
}
