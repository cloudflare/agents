/**
 * unset - Remove variables/functions builtin
 *
 * Supports:
 * - unset VAR - remove variable
 * - unset -v VAR - remove variable (explicit)
 * - unset -f FUNC - remove function
 * - unset 'a[i]' - remove array element (with arithmetic index support)
 *
 * Bash-specific unset scoping:
 * - local-unset (same scope): value-unset - clears value but keeps local cell
 * - dynamic-unset (different scope): cell-unset - removes local cell, exposes outer value
 */

import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import type { ExecResult } from "../../types";
import { evaluateArithmetic } from "../arithmetic";
import { isArray } from "../expansion/variable";
import { expandWord, getArrayElements } from "../expansion";
import { isNameref, resolveNameref } from "../helpers/nameref";
import { isReadonly } from "../helpers/readonly";
import { result } from "../helpers/result";
import type { InterpreterContext } from "../types";
import {
  clearLocalVarDepth,
  getLocalVarDepth,
  popLocalVarStack
} from "./variable-assignment";

/**
 * Check if a name is a valid bash variable name.
 * Valid names start with letter or underscore, followed by letters, digits, or underscores.
 */
function isValidVariableName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Check if an index expression is a quoted string (single or double quotes).
 * These are treated as associative array keys, not numeric indices.
 */
function isQuotedStringIndex(indexExpr: string): boolean {
  // Check for single-quoted or double-quoted string
  return (
    (indexExpr.startsWith("'") && indexExpr.endsWith("'")) ||
    (indexExpr.startsWith('"') && indexExpr.endsWith('"'))
  );
}

/**
 * Evaluate an array index expression (can be arithmetic).
 * Returns the evaluated numeric index, or null if the expression is a quoted
 * string that should be treated as an associative array key.
 */
async function evaluateArrayIndex(
  ctx: InterpreterContext,
  indexExpr: string
): Promise<number | null> {
  // If the index is a quoted string, it's meant for associative arrays only
  if (isQuotedStringIndex(indexExpr)) {
    return null;
  }
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, indexExpr);
    return await evaluateArithmetic(ctx, arithAst.expression);
  } catch {
    // If parsing fails, try to parse as simple number
    const num = parseInt(indexExpr, 10);
    return Number.isNaN(num) ? 0 : num;
  }
}

/**
 * Perform cell-unset for a local variable (dynamic-unset).
 * This removes the local cell and exposes the outer scope's value.
 * Uses the localVarStack for bash's localvar-nest behavior where multiple
 * nested local declarations can each be unset independently.
 * Returns true if a cell-unset was performed, false otherwise.
 */
function performCellUnset(ctx: InterpreterContext, varName: string): boolean {
  // Check if this variable uses the localVarStack (for nested local declarations)
  const hasStackEntry = ctx.state.localVarStack?.has(varName);

  if (hasStackEntry) {
    // This variable is managed by the localVarStack
    const stackEntry = popLocalVarStack(ctx, varName);
    if (stackEntry) {
      // Restore the value from the stack
      if (stackEntry.value === undefined) {
        ctx.state.env.delete(varName);
      } else {
        ctx.state.env.set(varName, stackEntry.value);
      }

      // Check if there are more entries in the stack
      const remainingStack = ctx.state.localVarStack?.get(varName);
      if (!remainingStack || remainingStack.length === 0) {
        // No more nested locals - clear the tracking
        clearLocalVarDepth(ctx, varName);
        // Also clean up the empty stack entry
        ctx.state.localVarStack?.delete(varName);
        // Mark this variable as "fully unset local" to prevent tempenv restoration
        // Use the scope index from the last popped entry (where the variable was declared)
        ctx.state.fullyUnsetLocals = ctx.state.fullyUnsetLocals || new Map();
        ctx.state.fullyUnsetLocals.set(varName, stackEntry.scopeIndex);

        // Bash 5.1 behavior: after cell-unset removes all locals, also remove tempenv
        // binding to reveal the global value (not the tempenv value)
        if (handleTempEnvUnset(ctx, varName)) {
          // Tempenv was removed, env[varName] now has the global value
        }
      } else {
        // Update localVarDepth to point to the now-top entry's scope
        // The scope index + 1 gives us the call depth where that local was declared
        const topEntry = remainingStack[remainingStack.length - 1];
        ctx.state.localVarDepth = ctx.state.localVarDepth || new Map();
        ctx.state.localVarDepth.set(varName, topEntry.scopeIndex + 1);
      }
      return true;
    }
    // Stack was empty but variable was stack-managed - just delete and clear tracking
    ctx.state.env.delete(varName);
    clearLocalVarDepth(ctx, varName);
    ctx.state.localVarStack?.delete(varName);
    // Mark as fully unset - use the outermost scope (0) since we don't know the original
    ctx.state.fullyUnsetLocals = ctx.state.fullyUnsetLocals || new Map();
    ctx.state.fullyUnsetLocals.set(varName, 0);
    return true;
  }

  // Fall back to the old behavior for variables without stack entries
  // (for backwards compatibility with existing local declarations)
  for (let i = ctx.state.localScopes.length - 1; i >= 0; i--) {
    const scope = ctx.state.localScopes[i];
    if (scope.has(varName)) {
      // Found the scope - restore the outer value
      const outerValue = scope.get(varName);
      if (outerValue === undefined) {
        ctx.state.env.delete(varName);
      } else {
        ctx.state.env.set(varName, outerValue);
      }
      // Remove from this scope so future lookups find the outer value
      scope.delete(varName);

      // Check if there's an outer scope that also has this variable
      // If so, update localVarDepth to that outer scope's depth
      // Otherwise, clear the tracking
      let foundOuterScope = false;
      for (let j = i - 1; j >= 0; j--) {
        if (ctx.state.localScopes[j].has(varName)) {
          // Found an outer scope with this variable
          // Scope at index j was created at callDepth j + 1
          if (ctx.state.localVarDepth) {
            ctx.state.localVarDepth.set(varName, j + 1);
          }
          foundOuterScope = true;
          break;
        }
      }
      if (!foundOuterScope) {
        clearLocalVarDepth(ctx, varName);
      }
      return true;
    }
  }
  return false;
}

/**
 * Handle unsetting a variable that may have a tempEnvBinding.
 * In bash, when you `unset v` where `v` was set by a prefix assignment (v=tempenv cmd),
 * it reveals the underlying (global) value instead of completely deleting the variable.
 * Returns true if a tempenv binding was found and handled, false otherwise.
 */
function handleTempEnvUnset(ctx: InterpreterContext, varName: string): boolean {
  if (!ctx.state.tempEnvBindings || ctx.state.tempEnvBindings.length === 0) {
    return false;
  }

  // Search from innermost (most recent) to outermost tempEnvBinding
  for (let i = ctx.state.tempEnvBindings.length - 1; i >= 0; i--) {
    const bindings = ctx.state.tempEnvBindings[i];
    if (bindings.has(varName)) {
      // Found a tempenv binding for this variable
      // Restore the underlying value (what was saved when the tempenv was created)
      const underlyingValue = bindings.get(varName);
      if (underlyingValue === undefined) {
        ctx.state.env.delete(varName);
      } else {
        ctx.state.env.set(varName, underlyingValue);
      }
      // Remove from this binding so future unsets will look at next layer
      bindings.delete(varName);
      return true;
    }
  }
  return false;
}

/**
 * Expand the subscript expression for an associative array key.
 * Handles single-quoted, double-quoted, and unquoted subscripts.
 */
async function expandAssocSubscript(
  ctx: InterpreterContext,
  subscriptExpr: string
): Promise<string> {
  if (subscriptExpr.startsWith("'") && subscriptExpr.endsWith("'")) {
    // Single-quoted: literal value, no expansion
    return subscriptExpr.slice(1, -1);
  }
  if (subscriptExpr.startsWith('"') && subscriptExpr.endsWith('"')) {
    // Double-quoted: expand variables inside
    const inner = subscriptExpr.slice(1, -1);
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(inner, true, false);
    return expandWord(ctx, wordNode);
  }
  if (subscriptExpr.includes("$")) {
    // Unquoted with variable reference
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(subscriptExpr, false, false);
    return expandWord(ctx, wordNode);
  }
  // Plain literal
  return subscriptExpr;
}

export async function handleUnset(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  let mode: "variable" | "function" | "both" = "both"; // Default: unset both var and func
  let stderr = "";
  let exitCode = 0;

  for (const arg of args) {
    // Handle flags
    if (arg === "-v") {
      mode = "variable"; // Explicit: only variable
      continue;
    }
    if (arg === "-f") {
      mode = "function";
      continue;
    }

    if (mode === "function") {
      ctx.state.functions.delete(arg);
      continue;
    }

    // If mode is "variable", only delete variables, not functions
    if (mode === "variable") {
      // Handle array element syntax: varName[index]
      const arrayMatchVar = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
      if (arrayMatchVar) {
        const arrayName = arrayMatchVar[1];
        const indexExpr = arrayMatchVar[2];

        if (indexExpr === "@" || indexExpr === "*") {
          const elements = getArrayElements(ctx, arrayName);
          for (const [idx] of elements) {
            ctx.state.env.delete(`${arrayName}_${idx}`);
          }
          ctx.state.env.delete(arrayName);
          continue;
        }

        // Check if this is an associative array
        const isAssoc = ctx.state.associativeArrays?.has(arrayName);

        if (isAssoc) {
          // For associative arrays, expand variables in the subscript
          const key = await expandAssocSubscript(ctx, indexExpr);
          ctx.state.env.delete(`${arrayName}_${key}`);
          continue;
        }

        // Check if variable is an indexed array
        const isIndexedArray = isArray(ctx, arrayName);
        // Check if variable was explicitly declared as a scalar (not an array)
        // A scalar exists when the base var name is in env (or declared but unset) but it's not an array
        const isDeclaredButUnset = ctx.state.declaredVars?.has(arrayName);
        const isScalar =
          (ctx.state.env.has(arrayName) || isDeclaredButUnset) &&
          !isIndexedArray &&
          !isAssoc;

        if (isScalar) {
          // Trying to unset array element on explicitly declared scalar variable
          stderr += `bash: unset: ${arrayName}: not an array variable\n`;
          exitCode = 1;
          continue;
        }

        // Indexed array: evaluate index as arithmetic expression
        const index = await evaluateArrayIndex(ctx, indexExpr);

        // If index is null, it's a quoted string key - error for indexed arrays
        // Only error if the variable is actually an indexed array
        if (index === null && isIndexedArray) {
          stderr += `bash: unset: ${indexExpr}: not a valid identifier\n`;
          exitCode = 1;
          continue;
        }

        // If variable doesn't exist at all and we have a quoted string key,
        // just silently succeed
        if (index === null) {
          continue;
        }

        if (index < 0) {
          const elements = getArrayElements(ctx, arrayName);
          const len = elements.length;
          const lineNum = ctx.state.currentLine;
          if (len === 0) {
            stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript\n`;
            exitCode = 1;
            continue;
          }
          const actualPos = len + index;
          if (actualPos < 0) {
            stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript\n`;
            exitCode = 1;
            continue;
          }
          const actualIndex = elements[actualPos][0];
          ctx.state.env.delete(`${arrayName}_${actualIndex}`);
          continue;
        }

        ctx.state.env.delete(`${arrayName}_${index}`);
        continue;
      }

      // Regular variable with -v: only delete variable, NOT function
      // Validate variable name
      if (!isValidVariableName(arg)) {
        stderr += `bash: unset: \`${arg}': not a valid identifier\n`;
        exitCode = 1;
        continue;
      }

      let targetName = arg;
      if (isNameref(ctx, arg)) {
        const resolved = resolveNameref(ctx, arg);
        if (resolved && resolved !== arg) {
          targetName = resolved;
        }
      }

      // Check if variable is readonly
      if (isReadonly(ctx, targetName)) {
        stderr += `bash: unset: ${targetName}: cannot unset: readonly variable\n`;
        exitCode = 1;
        continue;
      }

      // Bash-specific unset scoping: check if this is a dynamic-unset
      const localDepth = getLocalVarDepth(ctx, targetName);
      if (localDepth !== undefined && localDepth !== ctx.state.callDepth) {
        // Dynamic-unset: called from a different scope than where local was declared
        // Perform cell-unset to expose outer value
        performCellUnset(ctx, targetName);
      } else if (ctx.state.fullyUnsetLocals?.has(targetName)) {
        // This variable was a local that has been fully unset
        // Don't restore from tempenv, just delete
        ctx.state.env.delete(targetName);
      } else if (localDepth !== undefined) {
        // Local-unset: variable is local and we're in the same scope
        // In bash 5.1, this is a "value-unset" for locals declared without tempenv access
        // But if the tempenv was accessed (read or written) before the local declaration,
        // we should pop from stack to reveal the tempenv/mutated value
        const tempEnvAccessed = ctx.state.accessedTempEnvVars?.has(targetName);
        const tempEnvMutated = ctx.state.mutatedTempEnvVars?.has(targetName);
        if (
          (tempEnvAccessed || tempEnvMutated) &&
          ctx.state.localVarStack?.has(targetName)
        ) {
          // Tempenv was accessed before local declaration - pop from stack to reveal the value
          const stackEntry = popLocalVarStack(ctx, targetName);
          if (stackEntry) {
            if (stackEntry.value === undefined) {
              ctx.state.env.delete(targetName);
            } else {
              ctx.state.env.set(targetName, stackEntry.value);
            }
          } else {
            ctx.state.env.delete(targetName);
          }
        } else {
          // Tempenv not accessed - just value-unset (delete)
          ctx.state.env.delete(targetName);
        }
      } else if (!handleTempEnvUnset(ctx, targetName)) {
        // Not a local variable - check for tempenv binding
        // If found, reveal underlying value; otherwise just delete
        ctx.state.env.delete(targetName);
      }
      // Clear the export attribute - when variable is unset, it loses its export status
      ctx.state.exportedVars?.delete(targetName);
      continue;
    }

    // Check for array element syntax: varName[index]
    const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (arrayMatch) {
      const arrayName = arrayMatch[1];
      const indexExpr = arrayMatch[2];

      // Handle [@] or [*] - unset entire array
      if (indexExpr === "@" || indexExpr === "*") {
        const elements = getArrayElements(ctx, arrayName);
        for (const [idx] of elements) {
          ctx.state.env.delete(`${arrayName}_${idx}`);
        }
        ctx.state.env.delete(arrayName);
        continue;
      }

      // Check if this is an associative array
      const isAssoc = ctx.state.associativeArrays?.has(arrayName);

      if (isAssoc) {
        // For associative arrays, expand variables in the subscript
        const key = await expandAssocSubscript(ctx, indexExpr);
        ctx.state.env.delete(`${arrayName}_${key}`);
        continue;
      }

      // Check if variable is an indexed array
      const isIndexedArray = isArray(ctx, arrayName);
      // Check if variable was explicitly declared as a scalar (not an array)
      // A scalar exists when the base var name is in env but it's not an array
      const isScalar =
        ctx.state.env.has(arrayName) && !isIndexedArray && !isAssoc;

      if (isScalar) {
        // Trying to unset array element on explicitly declared scalar variable
        stderr += `bash: unset: ${arrayName}: not an array variable\n`;
        exitCode = 1;
        continue;
      }

      // Indexed array: evaluate index as arithmetic expression
      const index = await evaluateArrayIndex(ctx, indexExpr);

      // If index is null, it's a quoted string key - error for indexed arrays
      // Only error if the variable is actually an indexed array
      if (index === null && isIndexedArray) {
        stderr += `bash: unset: ${indexExpr}: not a valid identifier\n`;
        exitCode = 1;
        continue;
      }

      // If variable doesn't exist at all and we have a quoted string key,
      // just silently succeed
      if (index === null) {
        continue;
      }

      // Handle negative indices
      if (index < 0) {
        const elements = getArrayElements(ctx, arrayName);
        const len = elements.length;
        const lineNum = ctx.state.currentLine;
        if (len === 0) {
          // Empty array with negative index - error
          stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript\n`;
          exitCode = 1;
          continue;
        }
        // Convert negative index to actual position in sparse array
        const actualPos = len + index;
        if (actualPos < 0) {
          // Out of bounds negative index - error
          stderr += `bash: line ${lineNum}: unset: [${index}]: bad array subscript\n`;
          exitCode = 1;
          continue;
        }
        // Get the actual index from the sorted elements
        const actualIndex = elements[actualPos][0];
        ctx.state.env.delete(`${arrayName}_${actualIndex}`);
        continue;
      }

      // Positive index - just delete directly
      ctx.state.env.delete(`${arrayName}_${index}`);
      continue;
    }

    // Regular variable - check if it's a nameref and unset the target
    // Validate variable name
    if (!isValidVariableName(arg)) {
      stderr += `bash: unset: \`${arg}': not a valid identifier\n`;
      exitCode = 1;
      continue;
    }

    let targetName = arg;
    if (isNameref(ctx, arg)) {
      const resolved = resolveNameref(ctx, arg);
      if (resolved && resolved !== arg) {
        targetName = resolved;
      }
    }

    // Check if variable is readonly
    if (isReadonly(ctx, targetName)) {
      stderr += `bash: unset: ${targetName}: cannot unset: readonly variable\n`;
      exitCode = 1;
      continue;
    }

    // Bash-specific unset scoping: check if this is a dynamic-unset
    const localDepth = getLocalVarDepth(ctx, targetName);
    if (localDepth !== undefined && localDepth !== ctx.state.callDepth) {
      // Dynamic-unset: called from a different scope than where local was declared
      // Perform cell-unset to expose outer value
      performCellUnset(ctx, targetName);
    } else if (ctx.state.fullyUnsetLocals?.has(targetName)) {
      // This variable was a local that has been fully unset
      // Don't restore from tempenv, just delete
      ctx.state.env.delete(targetName);
    } else if (localDepth !== undefined) {
      // Local-unset: variable is local and we're in the same scope
      // In bash 5.1, this is a "value-unset" for locals declared without tempenv access
      // But if the tempenv was accessed (read or written) before the local declaration,
      // we should pop from stack to reveal the tempenv/mutated value
      const tempEnvAccessed = ctx.state.accessedTempEnvVars?.has(targetName);
      const tempEnvMutated = ctx.state.mutatedTempEnvVars?.has(targetName);
      if (
        (tempEnvAccessed || tempEnvMutated) &&
        ctx.state.localVarStack?.has(targetName)
      ) {
        // Tempenv was accessed before local declaration - pop from stack to reveal the value
        const stackEntry = popLocalVarStack(ctx, targetName);
        if (stackEntry) {
          if (stackEntry.value === undefined) {
            ctx.state.env.delete(targetName);
          } else {
            ctx.state.env.set(targetName, stackEntry.value);
          }
        } else {
          ctx.state.env.delete(targetName);
        }
      } else {
        // Tempenv not accessed - just value-unset (delete)
        ctx.state.env.delete(targetName);
      }
    } else if (!handleTempEnvUnset(ctx, targetName)) {
      // Not a local variable - check for tempenv binding
      // If found, reveal underlying value; otherwise just delete
      ctx.state.env.delete(targetName);
    }
    // Clear the export attribute - when variable is unset, it loses its export status
    ctx.state.exportedVars?.delete(targetName);
    ctx.state.functions.delete(arg);
  }
  return result("", stderr, exitCode);
}
