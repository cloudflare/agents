/**
 * Array Word Expansion Handlers
 *
 * Handles complex array expansion cases in word expansion:
 * - "${arr[@]}" and "${arr[*]}" - array element expansion
 * - "${arr[@]:-default}" - array with defaults
 * - "${arr[@]:offset:length}" - array slicing
 * - "${arr[@]/pattern/replacement}" - pattern replacement
 * - "${arr[@]#pattern}" - pattern removal
 * - "${arr[@]@op}" - transform operations
 */

import type { WordPart } from "../../ast/types";
import { getNamerefTarget, isNameref } from "../helpers/nameref";
import type { InterpreterContext } from "../types";
import { getArrayElements } from "./variable";

/**
 * Result type for array expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type ArrayExpansionResult = { values: string[]; quoted: boolean } | null;

/**
 * Helper type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (
  ctx: InterpreterContext,
  parts: WordPart[]
) => Promise<string>;

/**
 * Helper type for expandPart function reference
 */
export type ExpandPartFn = (
  ctx: InterpreterContext,
  part: WordPart
) => Promise<string>;

/**
 * Handle simple "${arr[@]}" expansion without operations.
 * Returns each array element as a separate word.
 */
export function handleSimpleArrayExpansion(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): ArrayExpansionResult {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  if (
    dqPart.parts.length !== 1 ||
    dqPart.parts[0].type !== "ParameterExpansion"
  ) {
    return null;
  }

  const paramPart = dqPart.parts[0];
  // Check if it's ONLY the array expansion (like "${a[@]}") without operations
  if (paramPart.operation) {
    return null;
  }

  const arrayMatch = paramPart.parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[(@)\]$/
  );
  if (!arrayMatch) {
    return null;
  }

  const arrayName = arrayMatch[1];

  // Special case: if arrayName is a nameref pointing to array[@],
  // ${ref[@]} doesn't do double indirection - it returns empty
  if (isNameref(ctx, arrayName)) {
    const target = getNamerefTarget(ctx, arrayName);
    if (target?.endsWith("[@]") || target?.endsWith("[*]")) {
      // ref points to arr[@], so ${ref[@]} is invalid/empty
      return { values: [], quoted: true };
    }
  }

  const elements = getArrayElements(ctx, arrayName);
  if (elements.length > 0) {
    // Return each element as a separate word
    return { values: elements.map(([, v]) => v), quoted: true };
  }

  // No array elements - check for scalar variable
  // ${s[@]} where s='abc' should return 'abc' (treat scalar as single-element array)
  // But NOT if the scalar value is actually from a nameref to array[@]
  const scalarValue = ctx.state.env.get(arrayName);
  if (scalarValue !== undefined) {
    return { values: [scalarValue], quoted: true };
  }

  // Variable is unset - return empty
  return { values: [], quoted: true };
}

/**
 * Handle namerefs pointing to array[@] - "${ref}" where ref='arr[@]'
 * When a nameref points to array[@], expanding "$ref" should produce multiple words
 */
export function handleNamerefArrayExpansion(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): ArrayExpansionResult {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  if (
    dqPart.parts.length !== 1 ||
    dqPart.parts[0].type !== "ParameterExpansion" ||
    dqPart.parts[0].operation
  ) {
    return null;
  }

  const paramPart = dqPart.parts[0];
  const varName = paramPart.parameter;

  // Check if it's a simple variable name (not already an array subscript)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName) || !isNameref(ctx, varName)) {
    return null;
  }

  const target = getNamerefTarget(ctx, varName);
  if (!target) {
    return null;
  }

  // Check if resolved target is array[@]
  const targetArrayMatch = target.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(@)\]$/);
  if (!targetArrayMatch) {
    return null;
  }

  const arrayName = targetArrayMatch[1];
  const elements = getArrayElements(ctx, arrayName);
  if (elements.length > 0) {
    // Return each element as a separate word
    return { values: elements.map(([, v]) => v), quoted: true };
  }

  // No array elements - check for scalar variable
  const scalarValue = ctx.state.env.get(arrayName);
  if (scalarValue !== undefined) {
    return { values: [scalarValue], quoted: true };
  }

  // Variable is unset - return empty
  return { values: [], quoted: true };
}
