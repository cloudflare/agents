/**
 * Array Slicing and Transform Operations
 *
 * Handles array expansion with slicing and transform operators:
 * - "${arr[@]:offset}" and "${arr[@]:offset:length}" - array slicing
 * - "${arr[@]@a}", "${arr[@]@P}", "${arr[@]@Q}" - transform operations
 */

import type { SubstringOp, WordPart } from "../../ast/types";
import { ArithmeticError, ExitError } from "../errors";
import { getIfsSeparator } from "../helpers/ifs";
import type { InterpreterContext } from "../types";
import { expandPrompt } from "./prompt";
import { quoteValue } from "./quoting";
import { getArrayElements } from "./variable";
import { getVariableAttributes } from "./variable-attrs";

/**
 * Result type for array expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type ArrayExpansionResult = { values: string[]; quoted: boolean } | null;

import type { ArithExpr } from "../../ast/types";

/**
 * Type for evaluateArithmetic function
 */
export type EvaluateArithmeticFn = (
  ctx: InterpreterContext,
  expr: ArithExpr,
  isExpansionContext?: boolean
) => Promise<number>;

/**
 * Handle "${arr[@]:offset}" and "${arr[@]:offset:length}" - array slicing with multiple return values
 * "${arr[@]:n:m}" returns m elements starting from index n as separate words
 * "${arr[*]:n:m}" returns m elements starting from index n joined with IFS as one word
 */
export async function handleArraySlicing(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  evaluateArithmetic: EvaluateArithmeticFn
): Promise<ArrayExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  if (
    dqPart.parts.length !== 1 ||
    dqPart.parts[0].type !== "ParameterExpansion" ||
    dqPart.parts[0].operation?.type !== "Substring"
  ) {
    return null;
  }

  const paramPart = dqPart.parts[0];
  const arrayMatch = paramPart.parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
  );
  if (!arrayMatch) {
    return null;
  }

  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const operation = paramPart.operation as SubstringOp;

  // Slicing associative arrays doesn't make sense - error out
  if (ctx.state.associativeArrays?.has(arrayName)) {
    throw new ExitError(
      1,
      "",
      `bash: \${${arrayName}[@]: 0: 3}: bad substitution\n`
    );
  }

  // Evaluate offset and length
  const offset = operation.offset
    ? await evaluateArithmetic(ctx, operation.offset.expression)
    : 0;
  const length = operation.length
    ? await evaluateArithmetic(ctx, operation.length.expression)
    : undefined;

  // Get array elements (sorted by index)
  const elements = getArrayElements(ctx, arrayName);

  // For sparse arrays, offset refers to index position, not element position
  // Find the first element whose index >= offset (or computed index for negative offset)
  let startIdx = 0;
  if (offset < 0) {
    // Negative offset: count from maxIndex + 1
    // e.g., -1 means elements with index >= maxIndex
    if (elements.length > 0) {
      const lastIdx = elements[elements.length - 1][0];
      const maxIndex = typeof lastIdx === "number" ? lastIdx : 0;
      const targetIndex = maxIndex + 1 + offset;
      // If target index is negative, return empty (out of bounds)
      if (targetIndex < 0) {
        return { values: [], quoted: true };
      }
      // Find first element with index >= targetIndex
      startIdx = elements.findIndex(
        ([idx]) => typeof idx === "number" && idx >= targetIndex
      );
      if (startIdx < 0) startIdx = elements.length; // All elements have smaller index
    }
  } else {
    // Positive offset: find first element with index >= offset
    startIdx = elements.findIndex(
      ([idx]) => typeof idx === "number" && idx >= offset
    );
    if (startIdx < 0) startIdx = elements.length; // All elements have smaller index
  }

  let slicedValues: string[];
  if (length !== undefined) {
    if (length < 0) {
      // Negative length is an error for array slicing in bash
      throw new ArithmeticError(`${arrayName}[@]: substring expression < 0`);
    }
    // Take 'length' elements starting from startIdx
    slicedValues = elements
      .slice(startIdx, startIdx + length)
      .map(([, v]) => v);
  } else {
    // Take all elements starting from startIdx
    slicedValues = elements.slice(startIdx).map(([, v]) => v);
  }

  if (slicedValues.length === 0) {
    return { values: [], quoted: true };
  }

  if (isStar) {
    // "${arr[*]:n:m}" - join with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [slicedValues.join(ifsSep)], quoted: true };
  }

  // "${arr[@]:n:m}" - each element as a separate word
  return { values: slicedValues, quoted: true };
}

/**
 * Handle "${arr[@]@a}", "${arr[@]@P}", "${arr[@]@Q}" - array Transform operations
 * "${arr[@]@a}": Return attribute letter for each element (e.g., 'a' for indexed array)
 * "${arr[@]@P}": Return each element's value (prompt expansion, limited implementation)
 * "${arr[@]@Q}": Return each element quoted for shell reuse
 * "${arr[*]@X}": Same as above but joined with IFS as one word
 */
export function handleArrayTransform(
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
    dqPart.parts[0].operation?.type !== "Transform"
  ) {
    return null;
  }

  const paramPart = dqPart.parts[0];
  const arrayMatch = paramPart.parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
  );
  if (!arrayMatch) {
    return null;
  }

  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";
  const operation = paramPart.operation as {
    type: "Transform";
    operator: string;
  };

  // Get array elements
  const elements = getArrayElements(ctx, arrayName);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      // Scalar variable - return based on operator
      let resultValue: string;
      switch (operation.operator) {
        case "a":
          resultValue = ""; // Scalars have no array attribute
          break;
        case "P":
          resultValue = expandPrompt(ctx, scalarValue);
          break;
        case "Q":
          resultValue = quoteValue(scalarValue);
          break;
        default:
          resultValue = scalarValue;
      }
      return { values: [resultValue], quoted: true };
    }
    // Variable is unset
    if (isStar) {
      return { values: [""], quoted: true };
    }
    return { values: [], quoted: true };
  }

  // Get the attribute for this array (same for all elements)
  const arrayAttr = getVariableAttributes(ctx, arrayName);

  // Transform each element based on operator
  let transformedValues: string[];
  switch (operation.operator) {
    case "a":
      // Return attribute letter for each element
      // All elements of the same array have the same attribute
      transformedValues = elements.map(() => arrayAttr);
      break;
    case "P":
      // Apply prompt expansion to each element
      transformedValues = elements.map(([, v]) => expandPrompt(ctx, v));
      break;
    case "Q":
      // Quote each element
      transformedValues = elements.map(([, v]) => quoteValue(v));
      break;
    case "u":
      // Capitalize first character only (ucfirst)
      transformedValues = elements.map(
        ([, v]) => v.charAt(0).toUpperCase() + v.slice(1)
      );
      break;
    case "U":
      // Uppercase all characters
      transformedValues = elements.map(([, v]) => v.toUpperCase());
      break;
    case "L":
      // Lowercase all characters
      transformedValues = elements.map(([, v]) => v.toLowerCase());
      break;
    default:
      transformedValues = elements.map(([, v]) => v);
  }

  if (isStar) {
    // "${arr[*]@X}" - join all values with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [transformedValues.join(ifsSep)], quoted: true };
  }

  // "${arr[@]@X}" - each value as a separate word
  return { values: transformedValues, quoted: true };
}
