/**
 * Readonly and export variable helpers.
 *
 * Consolidates readonly and export variable logic used in declare, export, local, etc.
 */

import type { ExecResult } from "../../types";
import { ExitError } from "../errors";
import type { InterpreterContext } from "../types";

/**
 * Mark a variable as readonly.
 */
export function markReadonly(ctx: InterpreterContext, name: string): void {
  ctx.state.readonlyVars = ctx.state.readonlyVars || new Set();
  ctx.state.readonlyVars.add(name);
}

/**
 * Check if a variable is readonly.
 */
export function isReadonly(ctx: InterpreterContext, name: string): boolean {
  return ctx.state.readonlyVars?.has(name) ?? false;
}

/**
 * Check if a variable is readonly and throw an error if so.
 * Returns null if the variable is not readonly (can be modified).
 *
 * Assigning to a readonly variable is a fatal error that stops script execution.
 * This matches the behavior of dash, mksh, ash, and bash in POSIX mode.
 * (Note: bash in non-POSIX mode has a bug where multi-line readonly assignment
 * continues execution, but one-line still stops. We always stop.)
 *
 * @param ctx - Interpreter context
 * @param name - Variable name
 * @param command - Command name for error message (default: "bash")
 * @returns null if variable is not readonly (can be modified)
 * @throws ExitError if variable is readonly
 */
export function checkReadonlyError(
  ctx: InterpreterContext,
  name: string,
  command = "bash"
): ExecResult | null {
  if (isReadonly(ctx, name)) {
    const stderr = `${command}: ${name}: readonly variable\n`;
    // Assigning to a readonly variable is always fatal
    throw new ExitError(1, "", stderr);
  }
  return null;
}

/**
 * Mark a variable as exported.
 *
 * If we're inside a local scope and the variable is local (exists in the
 * current scope), track it as a locally-exported variable. When the scope
 * is popped, the export attribute will be removed if it wasn't exported
 * before entering the function.
 */
export function markExported(ctx: InterpreterContext, name: string): void {
  const wasExported = ctx.state.exportedVars?.has(name) ?? false;
  ctx.state.exportedVars = ctx.state.exportedVars || new Set();
  ctx.state.exportedVars.add(name);

  // If we're in a local scope and the variable is local, track it
  if (ctx.state.localScopes.length > 0) {
    const currentScope =
      ctx.state.localScopes[ctx.state.localScopes.length - 1];
    // Only track if: the variable is local AND it wasn't already exported before
    if (currentScope.has(name) && !wasExported) {
      // Initialize localExportedVars stack if needed
      if (!ctx.state.localExportedVars) {
        ctx.state.localExportedVars = [];
      }
      // Ensure we have a set for the current scope depth
      while (
        ctx.state.localExportedVars.length < ctx.state.localScopes.length
      ) {
        ctx.state.localExportedVars.push(new Set());
      }
      // Track this variable as locally exported
      ctx.state.localExportedVars[ctx.state.localExportedVars.length - 1].add(
        name
      );
    }
  }
}

/**
 * Remove the export attribute from a variable.
 * The variable value is preserved, just no longer exported to child processes.
 */
export function unmarkExported(ctx: InterpreterContext, name: string): void {
  ctx.state.exportedVars?.delete(name);
}
