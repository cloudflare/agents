/**
 * Variable Attributes
 *
 * Functions for getting variable attributes (${var@a} transformation).
 */

import { isNameref } from "../helpers/nameref";
import { isReadonly } from "../helpers/readonly";
import type { InterpreterContext } from "../types";

/**
 * Get the attributes of a variable for ${var@a} transformation.
 * Returns a string with attribute flags (e.g., "ar" for readonly array).
 *
 * Attribute flags (in order):
 * - a: indexed array
 * - A: associative array
 * - i: integer
 * - n: nameref
 * - r: readonly
 * - x: exported
 */
export function getVariableAttributes(
  ctx: InterpreterContext,
  name: string
): string {
  // Handle special variables (like ?, $, etc.) - they have no attributes
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return "";
  }

  let attrs = "";

  // Check for indexed array (has numeric elements via name_0, name_1, etc. or __length marker)
  const isIndexedArray =
    ctx.state.env.has(`${name}__length`) ||
    Array.from(ctx.state.env.keys()).some(
      (k) =>
        k.startsWith(`${name}_`) && /^[0-9]+$/.test(k.slice(name.length + 1))
    );

  // Check for associative array
  const isAssocArray = ctx.state.associativeArrays?.has(name) ?? false;

  // Add array attributes (indexed before associative)
  if (isIndexedArray && !isAssocArray) {
    attrs += "a";
  }
  if (isAssocArray) {
    attrs += "A";
  }

  // Check for integer attribute
  if (ctx.state.integerVars?.has(name)) {
    attrs += "i";
  }

  // Check for nameref attribute
  if (isNameref(ctx, name)) {
    attrs += "n";
  }

  // Check for readonly attribute
  if (isReadonly(ctx, name)) {
    attrs += "r";
  }

  // Check for exported attribute
  if (ctx.state.exportedVars?.has(name)) {
    attrs += "x";
  }

  return attrs;
}
