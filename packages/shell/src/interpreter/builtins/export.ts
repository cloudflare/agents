/**
 * export - Set environment variables builtin
 *
 * Usage:
 *   export              - List all exported variables
 *   export -p           - List all exported variables (same as no args)
 *   export NAME=value   - Set and export variable
 *   export NAME+=value  - Append value and export variable
 *   export NAME         - Export existing variable (or create empty)
 *   export -n NAME      - Un-export variable (remove from env)
 */

import type { ExecResult } from "../../types";
import { markExported, unmarkExported } from "../helpers/readonly";
import { OK, result, success } from "../helpers/result";
import { expandTildesInValue } from "../helpers/tilde";
import type { InterpreterContext } from "../types";

export function handleExport(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  // Handle -n flag for un-export
  let unexport = false;
  const processedArgs: string[] = [];

  for (const arg of args) {
    if (arg === "-n") {
      unexport = true;
    } else if (arg === "-p") {
    } else if (arg === "--") {
    } else {
      processedArgs.push(arg);
    }
  }

  // No args or just -p: list all exported variables
  if (processedArgs.length === 0 && !unexport) {
    let stdout = "";
    // Only list variables that are actually exported
    const exportedVars = ctx.state.exportedVars ?? new Set();
    const sortedNames = Array.from(exportedVars).sort();

    for (const name of sortedNames) {
      const value = ctx.state.env.get(name);
      if (value !== undefined) {
        // Quote the value with double quotes, escaping backslashes and double quotes
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        stdout += `declare -x ${name}="${escapedValue}"\n`;
      }
    }
    return success(stdout);
  }

  // Handle un-export: remove export attribute but keep variable value
  // In bash, `export -n name=value` sets the value AND removes export attribute
  if (unexport) {
    for (const arg of processedArgs) {
      let name: string;
      let value: string | undefined;

      if (arg.includes("=")) {
        const eqIdx = arg.indexOf("=");
        name = arg.slice(0, eqIdx);
        value = expandTildesInValue(ctx, arg.slice(eqIdx + 1));
        // Set the value
        ctx.state.env.set(name, value);
      } else {
        name = arg;
      }
      // Remove export attribute without deleting the variable
      unmarkExported(ctx, name);
    }
    return OK;
  }

  // Process each argument
  let stderr = "";
  let exitCode = 0;

  for (const arg of processedArgs) {
    let name: string;
    let value: string | undefined;
    let isAppend = false;

    // Check for += append syntax: export NAME+=value
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      name = appendMatch[1];
      value = expandTildesInValue(ctx, appendMatch[2]);
      isAppend = true;
    } else if (arg.includes("=")) {
      // export NAME=value
      const eqIdx = arg.indexOf("=");
      name = arg.slice(0, eqIdx);
      value = expandTildesInValue(ctx, arg.slice(eqIdx + 1));
    } else {
      // export NAME (without value)
      name = arg;
    }

    // Validate variable name: must start with letter/underscore, contain only alphanumeric/_
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      stderr += `bash: export: \`${arg}': not a valid identifier\n`;
      exitCode = 1;
      continue;
    }

    if (value !== undefined) {
      if (isAppend) {
        // Append to existing value (or set if not defined)
        const existing = ctx.state.env.get(name) ?? "";
        ctx.state.env.set(name, existing + value);
      } else {
        ctx.state.env.set(name, value);
      }
    } else {
      // If variable doesn't exist, create it as empty
      if (!ctx.state.env.has(name)) {
        ctx.state.env.set(name, "");
      }
    }
    // Mark the variable as exported
    markExported(ctx, name);
  }

  return result("", stderr, exitCode);
}
