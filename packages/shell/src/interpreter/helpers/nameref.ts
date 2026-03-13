/**
 * Nameref (declare -n) support
 *
 * Namerefs are variables that reference other variables by name.
 * When a nameref is accessed, it transparently dereferences to the target variable.
 */

import type { InterpreterContext } from "../types";

/**
 * Check if a variable is a nameref
 */
export function isNameref(ctx: InterpreterContext, name: string): boolean {
  return ctx.state.namerefs?.has(name) ?? false;
}

/**
 * Mark a variable as a nameref
 */
export function markNameref(ctx: InterpreterContext, name: string): void {
  ctx.state.namerefs ??= new Set();
  ctx.state.namerefs.add(name);
}

/**
 * Remove the nameref attribute from a variable
 */
export function unmarkNameref(ctx: InterpreterContext, name: string): void {
  ctx.state.namerefs?.delete(name);
  ctx.state.boundNamerefs?.delete(name);
  ctx.state.invalidNamerefs?.delete(name);
}

/**
 * Mark a nameref as having an "invalid" target at creation time.
 * Invalid namerefs always read/write their value directly, never resolving.
 */
export function markNamerefInvalid(
  ctx: InterpreterContext,
  name: string
): void {
  ctx.state.invalidNamerefs ??= new Set();
  ctx.state.invalidNamerefs.add(name);
}

/**
 * Check if a nameref was created with an invalid target.
 */
function isNamerefInvalid(ctx: InterpreterContext, name: string): boolean {
  return ctx.state.invalidNamerefs?.has(name) ?? false;
}

/**
 * Mark a nameref as "bound" - meaning its target existed at creation time.
 * This is kept for tracking purposes but is currently not used in resolution.
 */
export function markNamerefBound(ctx: InterpreterContext, name: string): void {
  ctx.state.boundNamerefs ??= new Set();
  ctx.state.boundNamerefs.add(name);
}

/**
 * Check if a name refers to a valid, existing variable or array element.
 * Used to determine if a nameref target is "real" or just a stored value.
 */
export function targetExists(ctx: InterpreterContext, target: string): boolean {
  // Check for array subscript
  const arrayMatch = target.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    // Check if array exists (has any elements or is declared as assoc)
    const hasElements = Array.from(ctx.state.env.keys()).some(
      (k) => k.startsWith(`${arrayName}_`) && !k.includes("__")
    );
    const isAssoc = ctx.state.associativeArrays?.has(arrayName) ?? false;
    return hasElements || isAssoc;
  }

  // Check if it's an array (stored as target_0, target_1, etc.)
  const hasArrayElements = Array.from(ctx.state.env.keys()).some(
    (k) => k.startsWith(`${target}_`) && !k.includes("__")
  );
  if (hasArrayElements) {
    return true;
  }

  // Check if scalar variable exists
  return ctx.state.env.has(target);
}

/**
 * Resolve a nameref chain to the final variable name.
 * Returns the original name if it's not a nameref.
 * Detects circular references and returns undefined.
 *
 * @param ctx - The interpreter context
 * @param name - The variable name to resolve
 * @param maxDepth - Maximum chain depth to prevent infinite loops (default 100)
 * @returns The resolved variable name, or undefined if circular reference detected
 */
export function resolveNameref(
  ctx: InterpreterContext,
  name: string,
  maxDepth = 100
): string | undefined {
  // If not a nameref, return as-is
  if (!isNameref(ctx, name)) {
    return name;
  }

  // If the nameref was created with an invalid target, it should never resolve.
  // It acts as a regular variable, returning its value directly.
  if (isNamerefInvalid(ctx, name)) {
    return name;
  }

  const seen = new Set<string>();
  let current = name;

  while (maxDepth-- > 0) {
    // Detect circular reference
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    // If not a nameref, we've reached the target
    if (!isNameref(ctx, current)) {
      return current;
    }

    // Get the target name from the variable's value
    const target = ctx.state.env.get(current);
    if (target === undefined || target === "") {
      // Empty or unset nameref - return the nameref itself
      return current;
    }

    // Validate target is a valid variable name (not special chars like #, @, *, etc.)
    // Allow array subscripts like arr[0] or arr[@]
    // Note: Numeric-only targets like '1' are NOT valid - bash doesn't resolve namerefs
    // to positional parameters. The nameref keeps its literal value.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(target)) {
      // Invalid nameref target - return the nameref itself (bash behavior)
      return current;
    }

    // Always resolve to the target for reading
    // (The target may not exist, which will result in empty string on read)
    current = target;
  }

  // Max depth exceeded - likely circular reference
  return undefined;
}

/**
 * Get the target name of a nameref (what it points to).
 * Returns the variable's value if it's a nameref, undefined otherwise.
 */
export function getNamerefTarget(
  ctx: InterpreterContext,
  name: string
): string | undefined {
  if (!isNameref(ctx, name)) {
    return undefined;
  }
  return ctx.state.env.get(name);
}

/**
 * Resolve a nameref for assignment purposes.
 * Unlike resolveNameref, this will resolve to the target variable name
 * even if the target doesn't exist yet (allowing creation).
 *
 * @param ctx - The interpreter context
 * @param name - The variable name to resolve
 * @param valueBeingAssigned - The value being assigned (needed for empty nameref handling)
 * @param maxDepth - Maximum chain depth to prevent infinite loops
 * @returns
 * - undefined if circular reference detected
 * - null if the nameref is empty and value is not an existing variable (skip assignment)
 * - The resolved target name otherwise (may be the nameref itself if target is invalid)
 */
export function resolveNamerefForAssignment(
  ctx: InterpreterContext,
  name: string,
  valueBeingAssigned?: string,
  maxDepth = 100
): string | null | undefined {
  // If not a nameref, return as-is
  if (!isNameref(ctx, name)) {
    return name;
  }

  // If the nameref was created with an invalid target, it should never resolve.
  // It acts as a regular variable, so assignment goes directly to it.
  if (isNamerefInvalid(ctx, name)) {
    return name;
  }

  const seen = new Set<string>();
  let current = name;

  while (maxDepth-- > 0) {
    // Detect circular reference
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    // If not a nameref, we've reached the target
    if (!isNameref(ctx, current)) {
      return current;
    }

    // Get the target name from the variable's value
    const target = ctx.state.env.get(current);
    if (target === undefined || target === "") {
      // Empty or unset nameref - special handling based on value being assigned
      // If the value is a valid variable name AND that variable exists, set it as target
      // Otherwise, the assignment is a no-op
      if (valueBeingAssigned !== undefined) {
        const isValidName = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(valueBeingAssigned);
        if (isValidName && targetExists(ctx, valueBeingAssigned)) {
          // Value is an existing variable - set it as the target
          return current;
        }
        // Value is not an existing variable - skip assignment (no-op)
        return null;
      }
      // No value provided - return the nameref itself
      return current;
    }

    // Validate target is a valid variable name (not special chars like #, @, *, etc.)
    // Allow array subscripts like arr[0] or arr[@]
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(target)) {
      // Invalid nameref target - assign to the nameref itself
      return current;
    }

    current = target;
  }

  // Max depth exceeded - likely circular reference
  return undefined;
}
