/**
 * Custom Commands API
 *
 * Provides types and utilities for registering user-provided TypeScript commands.
 */

import type { Command, CommandContext, ExecResult } from "./types";

/**
 * A custom command - either a Command object or a lazy loader.
 */
export type CustomCommand = Command | LazyCommand;

/**
 * Lazy-loaded custom command (for code-splitting).
 */
export interface LazyCommand {
  name: string;
  load: () => Promise<Command>;
}

/**
 * Type guard to check if a custom command is lazy-loaded.
 */
export function isLazyCommand(cmd: CustomCommand): cmd is LazyCommand {
  return "load" in cmd && typeof cmd.load === "function";
}

/**
 * Define a TypeScript command with type inference.
 * Convenience wrapper - you can also just use the Command interface directly.
 *
 * @example
 * ```ts
 * const hello = defineCommand("hello", async (args, ctx) => {
 *   const name = args[0] || "world";
 *   return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
 * });
 *
 * const bash = new Bash({ customCommands: [hello] });
 * await bash.exec("hello Alice"); // "Hello, Alice!\n"
 * ```
 */
export function defineCommand(
  name: string,
  execute: (args: string[], ctx: CommandContext) => Promise<ExecResult>
): Command {
  return { name, trusted: true, execute };
}

/**
 * Create a lazy-loaded wrapper for a custom command.
 * The command is only loaded when first executed.
 */
export function createLazyCustomCommand(lazy: LazyCommand): Command {
  let cached: Command | null = null;
  return {
    name: lazy.name,
    trusted: true,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (!cached) {
        cached = await lazy.load();
      }
      return cached.execute(args, ctx);
    }
  };
}
