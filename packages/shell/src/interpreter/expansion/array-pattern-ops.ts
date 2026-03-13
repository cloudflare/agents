/**
 * Array Pattern Operations
 *
 * Handles pattern replacement and pattern removal for array expansions:
 * - "${arr[@]/pattern/replacement}" - pattern replacement
 * - "${arr[@]#pattern}" - prefix removal
 * - "${arr[@]%pattern}" - suffix removal
 */

import type { WordNode, WordPart } from "../../ast/types";
import { createUserRegex } from "../../regex/index";
import { getIfsSeparator } from "../helpers/ifs";
import { escapeRegex } from "../helpers/regex";
import type { InterpreterContext } from "../types";
import type {
  ArrayExpansionResult,
  ExpandPartFn,
  ExpandWordPartsAsyncFn
} from "./array-word-expansion";
import { patternToRegex } from "./pattern";
import { applyPatternRemoval } from "./pattern-removal";
import { getArrayElements } from "./variable";

/**
 * Build a regex pattern from a WordNode pattern
 */
async function buildPatternRegex(
  ctx: InterpreterContext,
  pattern: WordNode,
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<string> {
  let regex = "";
  for (const part of pattern.parts) {
    if (part.type === "Glob") {
      regex += patternToRegex(
        part.pattern,
        true,
        ctx.state.shoptOptions.extglob
      );
    } else if (part.type === "Literal") {
      regex += patternToRegex(part.value, true, ctx.state.shoptOptions.extglob);
    } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
      regex += escapeRegex(part.value);
    } else if (part.type === "DoubleQuoted") {
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      regex += escapeRegex(expanded);
    } else if (part.type === "ParameterExpansion") {
      const expanded = await expandPart(ctx, part);
      regex += patternToRegex(expanded, true, ctx.state.shoptOptions.extglob);
    } else {
      const expanded = await expandPart(ctx, part);
      regex += escapeRegex(expanded);
    }
  }
  return regex;
}

/**
 * Handle "${arr[@]/pattern/replacement}" and "${arr[*]/pattern/replacement}"
 * Returns null if this handler doesn't apply.
 */
export async function handleArrayPatternReplacement(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<ArrayExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  if (
    dqPart.parts.length !== 1 ||
    dqPart.parts[0].type !== "ParameterExpansion" ||
    dqPart.parts[0].operation?.type !== "PatternReplacement"
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
    type: "PatternReplacement";
    pattern: WordNode;
    replacement: WordNode | null;
    all: boolean;
    anchor: "start" | "end" | null;
  };

  // Get array elements
  const elements = getArrayElements(ctx, arrayName);
  const values = elements.map(([, v]) => v);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      values.push(scalarValue);
    }
  }

  if (values.length === 0) {
    return { values: [], quoted: true };
  }

  // Build the replacement regex
  let regex = "";
  if (operation.pattern) {
    regex = await buildPatternRegex(
      ctx,
      operation.pattern,
      expandWordPartsAsync,
      expandPart
    );
  }

  const replacement = operation.replacement
    ? await expandWordPartsAsync(ctx, operation.replacement.parts)
    : "";

  // Apply anchor modifiers
  let regexPattern = regex;
  if (operation.anchor === "start") {
    regexPattern = `^${regex}`;
  } else if (operation.anchor === "end") {
    regexPattern = `${regex}$`;
  }

  // Apply replacement to each element
  const replacedValues: string[] = [];
  try {
    const re = createUserRegex(regexPattern, operation.all ? "g" : "");
    for (const value of values) {
      replacedValues.push(re.replace(value, replacement));
    }
  } catch {
    // Invalid regex - return values unchanged
    replacedValues.push(...values);
  }

  if (isStar) {
    // "${arr[*]/...}" - join all elements with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [replacedValues.join(ifsSep)], quoted: true };
  }

  // "${arr[@]/...}" - each element as a separate word
  return { values: replacedValues, quoted: true };
}

/**
 * Handle "${arr[@]#pattern}" and "${arr[*]#pattern}" - array pattern removal
 * Returns null if this handler doesn't apply.
 */
export async function handleArrayPatternRemoval(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<ArrayExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  if (
    dqPart.parts.length !== 1 ||
    dqPart.parts[0].type !== "ParameterExpansion" ||
    dqPart.parts[0].operation?.type !== "PatternRemoval"
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
  const operation = paramPart.operation as unknown as {
    type: "PatternRemoval";
    pattern: WordNode;
    side: "prefix" | "suffix";
    greedy: boolean;
  };

  // Get array elements
  const elements = getArrayElements(ctx, arrayName);
  const values = elements.map(([, v]) => v);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      values.push(scalarValue);
    }
  }

  if (values.length === 0) {
    return { values: [], quoted: true };
  }

  // Build the regex pattern string
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        regexStr += patternToRegex(part.value, operation.greedy, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync(ctx, part.parts);
        regexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart(ctx, part);
        regexStr += patternToRegex(expanded, operation.greedy, extglob);
      } else {
        const expanded = await expandPart(ctx, part);
        regexStr += escapeRegex(expanded);
      }
    }
  }

  // Apply pattern removal to each element
  const resultValues: string[] = [];
  for (const value of values) {
    resultValues.push(
      applyPatternRemoval(value, regexStr, operation.side, operation.greedy)
    );
  }

  if (isStar) {
    // "${arr[*]#...}" - join all elements with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return { values: [resultValues.join(ifsSep)], quoted: true };
  }

  // "${arr[@]#...}" - each element as a separate word
  return { values: resultValues, quoted: true };
}
