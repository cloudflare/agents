/**
 * Positional Parameter Expansion Handlers
 *
 * Handles $@ and $* expansion with various operations:
 * - "${@:offset}" and "${*:offset}" - slicing
 * - "${@/pattern/replacement}" - pattern replacement
 * - "${@#pattern}" - pattern removal (strip)
 * - "$@" and "$*" with adjacent text
 */

import type {
  ParameterExpansionPart,
  SubstringOp,
  WordNode,
  WordPart
} from "../../ast/types";
import { createUserRegex } from "../../regex/index";
import { getIfsSeparator } from "../helpers/ifs";
import { escapeRegex } from "../helpers/regex";
import type { InterpreterContext } from "../types";
import { patternToRegex } from "./pattern";
import { applyPatternRemoval } from "./pattern-removal";

/**
 * Result type for positional parameter expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type PositionalExpansionResult = {
  values: string[];
  quoted: boolean;
} | null;

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
 * Type for expandPart function
 */
export type ExpandPartFn = (
  ctx: InterpreterContext,
  part: WordPart
) => Promise<string>;

/**
 * Type for expandWordPartsAsync function
 */
export type ExpandWordPartsAsyncFn = (
  ctx: InterpreterContext,
  parts: WordPart[]
) => Promise<string>;

/**
 * Get positional parameters from context
 */
function getPositionalParams(ctx: InterpreterContext): string[] {
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
  const params: string[] = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env.get(String(i)) || "");
  }
  return params;
}

/**
 * Handle "${@:offset}" and "${*:offset}" with Substring operations inside double quotes
 * "${@:offset}": Each sliced positional parameter becomes a separate word
 * "${*:offset}": All sliced params joined with IFS as ONE word
 */
export async function handlePositionalSlicing(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  evaluateArithmetic: EvaluateArithmeticFn,
  expandPart: ExpandPartFn
): Promise<PositionalExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  // Find if there's a ${@:offset} or ${*:offset} inside
  let sliceAtIndex = -1;
  let sliceIsStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*") &&
      p.operation?.type === "Substring"
    ) {
      sliceAtIndex = i;
      sliceIsStar = p.parameter === "*";
      break;
    }
  }

  if (sliceAtIndex === -1) {
    return null;
  }

  const paramPart = dqPart.parts[sliceAtIndex] as ParameterExpansionPart;
  const operation = paramPart.operation as SubstringOp;

  // Evaluate offset and length
  const offset = operation.offset
    ? await evaluateArithmetic(ctx, operation.offset.expression)
    : 0;
  const length = operation.length
    ? await evaluateArithmetic(ctx, operation.length.expression)
    : undefined;

  // Get positional parameters
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
  const allParams: string[] = [];
  for (let i = 1; i <= numParams; i++) {
    allParams.push(ctx.state.env.get(String(i)) || "");
  }

  const shellName = ctx.state.env.get("0") || "bash";

  // Build sliced params array
  let slicedParams: string[];
  if (offset <= 0) {
    // offset 0: include $0 at position 0
    const withZero = [shellName, ...allParams];
    const computedIdx = withZero.length + offset;
    // If negative offset goes beyond array bounds, return empty
    if (computedIdx < 0) {
      slicedParams = [];
    } else {
      const startIdx = offset < 0 ? computedIdx : 0;
      if (length !== undefined) {
        const endIdx =
          length < 0 ? withZero.length + length : startIdx + length;
        slicedParams = withZero.slice(startIdx, Math.max(startIdx, endIdx));
      } else {
        slicedParams = withZero.slice(startIdx);
      }
    }
  } else {
    // offset > 0: start from $<offset>
    const startIdx = offset - 1;
    if (startIdx >= allParams.length) {
      slicedParams = [];
    } else if (length !== undefined) {
      const endIdx = length < 0 ? allParams.length + length : startIdx + length;
      slicedParams = allParams.slice(startIdx, Math.max(startIdx, endIdx));
    } else {
      slicedParams = allParams.slice(startIdx);
    }
  }

  // Expand prefix (parts before ${@:...})
  let prefix = "";
  for (let i = 0; i < sliceAtIndex; i++) {
    prefix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Expand suffix (parts after ${@:...})
  let suffix = "";
  for (let i = sliceAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart(ctx, dqPart.parts[i]);
  }

  if (slicedParams.length === 0) {
    // No params after slicing -> prefix + suffix as one word
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }

  if (sliceIsStar) {
    // "${*:offset}" - join all sliced params with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + slicedParams.join(ifsSep) + suffix],
      quoted: true
    };
  }

  // "${@:offset}" - each sliced param is a separate word
  if (slicedParams.length === 1) {
    return {
      values: [prefix + slicedParams[0] + suffix],
      quoted: true
    };
  }

  const result = [
    prefix + slicedParams[0],
    ...slicedParams.slice(1, -1),
    slicedParams[slicedParams.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}

/**
 * Handle "${@/pattern/replacement}" and "${* /pattern/replacement}" with PatternReplacement inside double quotes
 * "${@/pattern/replacement}": Each positional parameter has pattern replaced, each becomes a separate word
 * "${* /pattern/replacement}": All params joined with IFS, pattern replaced, becomes ONE word
 */
export async function handlePositionalPatternReplacement(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandPart: ExpandPartFn,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<PositionalExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  // Find if there's a ${@/...} or ${*/...} inside
  let patReplAtIndex = -1;
  let patReplIsStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*") &&
      p.operation?.type === "PatternReplacement"
    ) {
      patReplAtIndex = i;
      patReplIsStar = p.parameter === "*";
      break;
    }
  }

  if (patReplAtIndex === -1) {
    return null;
  }

  const paramPart = dqPart.parts[patReplAtIndex] as ParameterExpansionPart;
  const operation = paramPart.operation as {
    type: "PatternReplacement";
    pattern: WordNode;
    replacement: WordNode | null;
    all: boolean;
    anchor: "start" | "end" | null;
  };

  // Get positional parameters
  const params = getPositionalParams(ctx);

  // Expand prefix (parts before ${@/...})
  let prefix = "";
  for (let i = 0; i < patReplAtIndex; i++) {
    prefix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Expand suffix (parts after ${@/...})
  let suffix = "";
  for (let i = patReplAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart(ctx, dqPart.parts[i]);
  }

  if (params.length === 0) {
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }

  // Build the replacement regex
  let regex = "";
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regex += patternToRegex(
          part.pattern,
          true,
          ctx.state.shoptOptions.extglob
        );
      } else if (part.type === "Literal") {
        regex += patternToRegex(
          part.value,
          true,
          ctx.state.shoptOptions.extglob
        );
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

  // Apply replacement to each param
  const replacedParams: string[] = [];
  try {
    const re = createUserRegex(regexPattern, operation.all ? "g" : "");
    for (const param of params) {
      replacedParams.push(re.replace(param, replacement));
    }
  } catch {
    // Invalid regex - return params unchanged
    replacedParams.push(...params);
  }

  if (patReplIsStar) {
    // "${*/...}" - join all params with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + replacedParams.join(ifsSep) + suffix],
      quoted: true
    };
  }

  // "${@/...}" - each param is a separate word
  if (replacedParams.length === 1) {
    return {
      values: [prefix + replacedParams[0] + suffix],
      quoted: true
    };
  }

  const result = [
    prefix + replacedParams[0],
    ...replacedParams.slice(1, -1),
    replacedParams[replacedParams.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}

/**
 * Handle "${@#pattern}" and "${*#pattern}" - positional parameter pattern removal (strip)
 * "${@#pattern}": Remove shortest matching prefix from each parameter, each becomes a separate word
 * "${@##pattern}": Remove longest matching prefix from each parameter
 * "${@%pattern}": Remove shortest matching suffix from each parameter
 * "${@%%pattern}": Remove longest matching suffix from each parameter
 */
export async function handlePositionalPatternRemoval(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandPart: ExpandPartFn,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<PositionalExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  // Find if there's a ${@#...} or ${*#...} inside
  let patRemAtIndex = -1;
  let patRemIsStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*") &&
      p.operation?.type === "PatternRemoval"
    ) {
      patRemAtIndex = i;
      patRemIsStar = p.parameter === "*";
      break;
    }
  }

  if (patRemAtIndex === -1) {
    return null;
  }

  const paramPart = dqPart.parts[patRemAtIndex] as ParameterExpansionPart;
  const operation = paramPart.operation as {
    type: "PatternRemoval";
    pattern: WordNode;
    side: "prefix" | "suffix";
    greedy: boolean;
  };

  // Get positional parameters
  const params = getPositionalParams(ctx);

  // Expand prefix (parts before ${@#...})
  let prefix = "";
  for (let i = 0; i < patRemAtIndex; i++) {
    prefix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Expand suffix (parts after ${@#...})
  let suffix = "";
  for (let i = patRemAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart(ctx, dqPart.parts[i]);
  }

  if (params.length === 0) {
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }

  // Build the regex pattern
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

  // Apply pattern removal to each param
  const strippedParams: string[] = [];
  for (const param of params) {
    strippedParams.push(
      applyPatternRemoval(param, regexStr, operation.side, operation.greedy)
    );
  }

  if (patRemIsStar) {
    // "${*#...}" - join all params with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + strippedParams.join(ifsSep) + suffix],
      quoted: true
    };
  }

  // "${@#...}" - each param is a separate word
  if (strippedParams.length === 1) {
    return {
      values: [prefix + strippedParams[0] + suffix],
      quoted: true
    };
  }

  const result = [
    prefix + strippedParams[0],
    ...strippedParams.slice(1, -1),
    strippedParams[strippedParams.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}

/**
 * Handle "$@" and "$*" with adjacent text inside double quotes, e.g., "-$@-"
 * "$@": Each positional parameter becomes a separate word, with prefix joined to first
 *       and suffix joined to last. If no params, produces nothing (or just prefix+suffix if present)
 * "$*": All params joined with IFS as ONE word. If no params, produces one empty word.
 */
export async function handleSimplePositionalExpansion(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandPart: ExpandPartFn
): Promise<PositionalExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  // Find if there's a $@ or $* inside
  let atIndex = -1;
  let isStar = false;
  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*")
    ) {
      atIndex = i;
      isStar = p.parameter === "*";
      break;
    }
  }

  if (atIndex === -1) {
    return null;
  }

  // Check if this is a simple $@ or $* without operations like ${*-default}
  const paramPart = dqPart.parts[atIndex];
  if (paramPart.type === "ParameterExpansion" && paramPart.operation) {
    // Has an operation - let normal expansion handle it
    return null;
  }

  // Get positional parameters
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);

  // Expand prefix (parts before $@/$*)
  let prefix = "";
  for (let i = 0; i < atIndex; i++) {
    prefix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Expand suffix (parts after $@/$*)
  let suffix = "";
  for (let i = atIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart(ctx, dqPart.parts[i]);
  }

  if (numParams === 0) {
    if (isStar) {
      // "$*" with no params -> one empty word (prefix + suffix)
      return { values: [prefix + suffix], quoted: true };
    }
    // "$@" with no params -> no words (unless there's prefix/suffix)
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }

  // Get individual positional parameters
  const params: string[] = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env.get(String(i)) || "");
  }

  if (isStar) {
    // "$*" - join all params with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + params.join(ifsSep) + suffix],
      quoted: true
    };
  }

  // "$@" - each param is a separate word
  // Join prefix with first, suffix with last
  if (params.length === 1) {
    return { values: [prefix + params[0] + suffix], quoted: true };
  }

  const result = [
    prefix + params[0],
    ...params.slice(1, -1),
    params[params.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
