/**
 * Unquoted Expansion Handlers
 *
 * Handles unquoted positional parameter and array expansions:
 * - Unquoted $@ and $* (with and without prefix/suffix)
 * - Unquoted ${arr[@]} and ${arr[*]}
 * - Unquoted ${@:offset} and ${*:offset} slicing
 * - Unquoted ${@#pattern} and ${*#pattern} pattern removal
 * - Unquoted ${arr[@]/pattern/replacement} pattern replacement
 * - Unquoted ${arr[@]#pattern} pattern removal
 * - Unquoted ${!prefix@} and ${!prefix*} variable name prefix expansion
 * - Unquoted ${!arr[@]} and ${!arr[*]} array keys expansion
 */

import type {
  ArithExpr,
  ParameterExpansionPart,
  SubstringOp,
  WordNode,
  WordPart
} from "../../ast/types";
import { createUserRegex } from "../../regex/index";
import { GlobExpander } from "../../shell/glob";
import { GlobError } from "../errors";
import {
  getIfs,
  getIfsSeparator,
  isIfsEmpty,
  isIfsWhitespaceOnly,
  splitByIfsForExpansion
} from "../helpers/ifs";
import { escapeRegex } from "../helpers/regex";
import type { InterpreterContext } from "../types";
import { hasGlobPattern } from "./glob-escape";
import { patternToRegex } from "./pattern";
import { applyPatternRemoval, getVarNamesWithPrefix } from "./pattern-removal";
import { getArrayElements } from "./variable";

/**
 * Result type for unquoted expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type UnquotedExpansionResult = {
  values: string[];
  quoted: boolean;
} | null;

/**
 * Type for expandPart function reference
 */
export type ExpandPartFn = (
  ctx: InterpreterContext,
  part: WordPart
) => Promise<string>;

/**
 * Type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (
  ctx: InterpreterContext,
  parts: WordPart[]
) => Promise<string>;

/**
 * Type for evaluateArithmetic function
 */
export type EvaluateArithmeticFn = (
  ctx: InterpreterContext,
  expr: ArithExpr,
  isExpansionContext?: boolean
) => Promise<number>;

/**
 * Helper to create a GlobExpander with the given context
 */
function createGlobExpander(ctx: InterpreterContext): GlobExpander {
  return new GlobExpander(ctx.fs, ctx.state.cwd, ctx.state.env, {
    globstar: ctx.state.shoptOptions.globstar,
    nullglob: ctx.state.shoptOptions.nullglob,
    failglob: ctx.state.shoptOptions.failglob,
    dotglob: ctx.state.shoptOptions.dotglob,
    extglob: ctx.state.shoptOptions.extglob,
    globskipdots: ctx.state.shoptOptions.globskipdots,
    maxGlobOperations: ctx.limits.maxGlobOperations
  });
}

/**
 * Helper to apply glob expansion to a list of words
 */
async function applyGlobExpansion(
  ctx: InterpreterContext,
  words: string[]
): Promise<string[]> {
  if (ctx.state.options.noglob) {
    return words;
  }

  const globExpander = createGlobExpander(ctx);
  const expandedValues: string[] = [];

  for (const w of words) {
    if (hasGlobPattern(w, ctx.state.shoptOptions.extglob)) {
      const matches = await globExpander.expand(w);
      if (matches.length > 0) {
        expandedValues.push(...matches);
      } else if (globExpander.hasFailglob()) {
        throw new GlobError(w);
      } else if (globExpander.hasNullglob()) {
        // skip
      } else {
        expandedValues.push(w);
      }
    } else {
      expandedValues.push(w);
    }
  }

  return expandedValues;
}

/**
 * Handle unquoted ${array[@]/pattern/replacement} - apply to each element
 * This handles ${array[@]/#/prefix} (prepend) and ${array[@]/%/suffix} (append)
 */
export async function handleUnquotedArrayPatternReplacement(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<UnquotedExpansionResult> {
  let unquotedArrayPatReplIdx = -1;
  let unquotedArrayName = "";
  let unquotedArrayIsStar = false;

  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (
      p.type === "ParameterExpansion" &&
      p.operation?.type === "PatternReplacement"
    ) {
      const arrayMatch = p.parameter.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
      );
      if (arrayMatch) {
        unquotedArrayPatReplIdx = i;
        unquotedArrayName = arrayMatch[1];
        unquotedArrayIsStar = arrayMatch[2] === "*";
        break;
      }
    }
  }

  if (unquotedArrayPatReplIdx === -1) {
    return null;
  }

  const paramPart = wordParts[
    unquotedArrayPatReplIdx
  ] as ParameterExpansionPart;
  const operation = paramPart.operation as {
    type: "PatternReplacement";
    pattern: WordNode;
    replacement: WordNode | null;
    all: boolean;
    anchor: "start" | "end" | null;
  };

  // Get array elements
  const elements = getArrayElements(ctx, unquotedArrayName);
  let values = elements.map(([, v]) => v);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(unquotedArrayName);
    if (scalarValue !== undefined) {
      values = [scalarValue];
    }
  }

  if (values.length === 0) {
    return { values: [], quoted: false };
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

  // For unquoted, we need to IFS-split the result
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);

  if (unquotedArrayIsStar) {
    // ${arr[*]/...} unquoted - join with IFS, then split
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = replacedValues.join(ifsSep);
    if (ifsEmpty) {
      return { values: joined ? [joined] : [], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(joined, ifsChars),
      quoted: false
    };
  }

  // ${arr[@]/...} unquoted - each element separate, then IFS-split each
  if (ifsEmpty) {
    return { values: replacedValues, quoted: false };
  }

  const allWords: string[] = [];
  for (const val of replacedValues) {
    if (val === "") {
      allWords.push("");
    } else {
      allWords.push(...splitByIfsForExpansion(val, ifsChars));
    }
  }
  return { values: allWords, quoted: false };
}

/**
 * Handle unquoted ${array[@]#pattern} - apply pattern removal to each element
 * This handles ${array[@]#pattern} (strip shortest prefix), ${array[@]##pattern} (strip longest prefix)
 * ${array[@]%pattern} (strip shortest suffix), ${array[@]%%pattern} (strip longest suffix)
 */
export async function handleUnquotedArrayPatternRemoval(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<UnquotedExpansionResult> {
  let unquotedArrayPatRemIdx = -1;
  let unquotedArrayName = "";
  let unquotedArrayIsStar = false;

  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (
      p.type === "ParameterExpansion" &&
      p.operation?.type === "PatternRemoval"
    ) {
      const arrayMatch = p.parameter.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
      );
      if (arrayMatch) {
        unquotedArrayPatRemIdx = i;
        unquotedArrayName = arrayMatch[1];
        unquotedArrayIsStar = arrayMatch[2] === "*";
        break;
      }
    }
  }

  if (unquotedArrayPatRemIdx === -1) {
    return null;
  }

  const paramPart = wordParts[unquotedArrayPatRemIdx] as ParameterExpansionPart;
  const operation = paramPart.operation as {
    type: "PatternRemoval";
    pattern: WordNode;
    side: "prefix" | "suffix";
    greedy: boolean;
  };

  // Get array elements
  const elements = getArrayElements(ctx, unquotedArrayName);
  let values = elements.map(([, v]) => v);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(unquotedArrayName);
    if (scalarValue !== undefined) {
      values = [scalarValue];
    }
  }

  if (values.length === 0) {
    return { values: [], quoted: false };
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

  // Apply pattern removal to each element
  const strippedValues: string[] = [];
  for (const value of values) {
    strippedValues.push(
      applyPatternRemoval(value, regexStr, operation.side, operation.greedy)
    );
  }

  // For unquoted, we need to IFS-split the result
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);

  if (unquotedArrayIsStar) {
    // ${arr[*]#...} unquoted - join with IFS, then split
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = strippedValues.join(ifsSep);
    if (ifsEmpty) {
      return { values: joined ? [joined] : [], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(joined, ifsChars),
      quoted: false
    };
  }

  // ${arr[@]#...} unquoted - each element separate, then IFS-split each
  if (ifsEmpty) {
    return { values: strippedValues, quoted: false };
  }

  const allWords: string[] = [];
  for (const val of strippedValues) {
    if (val === "") {
      allWords.push("");
    } else {
      allWords.push(...splitByIfsForExpansion(val, ifsChars));
    }
  }
  return { values: allWords, quoted: false };
}

/**
 * Handle unquoted ${@#pattern} and ${*#pattern} - apply pattern removal to each positional parameter
 * This handles ${@#pattern} (strip shortest prefix), ${@##pattern} (strip longest prefix)
 * ${@%pattern} (strip shortest suffix), ${@%%pattern} (strip longest suffix)
 */
export async function handleUnquotedPositionalPatternRemoval(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<UnquotedExpansionResult> {
  let unquotedPosPatRemIdx = -1;
  let unquotedPosPatRemIsStar = false;

  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*") &&
      p.operation?.type === "PatternRemoval"
    ) {
      unquotedPosPatRemIdx = i;
      unquotedPosPatRemIsStar = p.parameter === "*";
      break;
    }
  }

  if (unquotedPosPatRemIdx === -1) {
    return null;
  }

  const paramPart = wordParts[unquotedPosPatRemIdx] as ParameterExpansionPart;
  const operation = paramPart.operation as {
    type: "PatternRemoval";
    pattern: WordNode;
    side: "prefix" | "suffix";
    greedy: boolean;
  };

  // Get positional parameters
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
  const params: string[] = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env.get(String(i)) || "");
  }

  if (params.length === 0) {
    return { values: [], quoted: false };
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

  // Apply pattern removal to each positional parameter
  const strippedParams: string[] = [];
  for (const param of params) {
    strippedParams.push(
      applyPatternRemoval(param, regexStr, operation.side, operation.greedy)
    );
  }

  // For unquoted, we need to IFS-split the result
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);

  if (unquotedPosPatRemIsStar) {
    // ${*#...} unquoted - join with IFS, then split
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = strippedParams.join(ifsSep);
    if (ifsEmpty) {
      return { values: joined ? [joined] : [], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(joined, ifsChars),
      quoted: false
    };
  }

  // ${@#...} unquoted - each param separate, then IFS-split each
  if (ifsEmpty) {
    return { values: strippedParams, quoted: false };
  }

  const allWords: string[] = [];
  for (const val of strippedParams) {
    if (val === "") {
      allWords.push("");
    } else {
      allWords.push(...splitByIfsForExpansion(val, ifsChars));
    }
  }
  return { values: allWords, quoted: false };
}

/**
 * Handle unquoted ${@:offset} and ${*:offset} (with potential prefix/suffix)
 */
export async function handleUnquotedPositionalSlicing(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  evaluateArithmetic: EvaluateArithmeticFn,
  expandPart: ExpandPartFn
): Promise<UnquotedExpansionResult> {
  let unquotedSliceAtIndex = -1;
  let unquotedSliceIsStar = false;

  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*") &&
      p.operation?.type === "Substring"
    ) {
      unquotedSliceAtIndex = i;
      unquotedSliceIsStar = p.parameter === "*";
      break;
    }
  }

  if (unquotedSliceAtIndex === -1) {
    return null;
  }

  const paramPart = wordParts[unquotedSliceAtIndex] as ParameterExpansionPart;
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
  for (let i = 0; i < unquotedSliceAtIndex; i++) {
    prefix += await expandPart(ctx, wordParts[i]);
  }

  // Expand suffix (parts after ${@:...})
  let suffix = "";
  for (let i = unquotedSliceAtIndex + 1; i < wordParts.length; i++) {
    suffix += await expandPart(ctx, wordParts[i]);
  }

  // For unquoted, we need to IFS-split the result
  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);

  if (slicedParams.length === 0) {
    // No params after slicing -> prefix + suffix as one word (may still need splitting)
    const combined = prefix + suffix;
    if (!combined) {
      return { values: [], quoted: false };
    }
    if (ifsEmpty) {
      return { values: [combined], quoted: false };
    }
    return {
      values: splitByIfsForExpansion(combined, ifsChars),
      quoted: false
    };
  }

  let allWords: string[];

  if (unquotedSliceIsStar) {
    // ${*:offset} unquoted - join all sliced params with IFS, then split result
    const ifsSep = getIfsSeparator(ctx.state.env);
    const joined = prefix + slicedParams.join(ifsSep) + suffix;

    if (ifsEmpty) {
      allWords = joined ? [joined] : [];
    } else {
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    // ${@:offset} unquoted - each sliced param is separate, then IFS-split each
    // Prefix attaches to first, suffix attaches to last
    if (ifsEmpty) {
      // No splitting - just attach prefix/suffix
      if (slicedParams.length === 1) {
        allWords = [prefix + slicedParams[0] + suffix];
      } else {
        allWords = [
          prefix + slicedParams[0],
          ...slicedParams.slice(1, -1),
          slicedParams[slicedParams.length - 1] + suffix
        ];
      }
    } else {
      // IFS-split each parameter
      allWords = [];
      for (let i = 0; i < slicedParams.length; i++) {
        let param = slicedParams[i];
        if (i === 0) param = prefix + param;
        if (i === slicedParams.length - 1) param = param + suffix;

        if (param === "") {
          allWords.push("");
        } else {
          const parts = splitByIfsForExpansion(param, ifsChars);
          allWords.push(...parts);
        }
      }
    }
  }

  // Apply glob expansion to each word
  return { values: await applyGlobExpansion(ctx, allWords), quoted: false };
}

/**
 * Handle unquoted $@ and $* (simple, without operations)
 */
export async function handleUnquotedSimplePositional(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): Promise<UnquotedExpansionResult> {
  if (
    wordParts.length !== 1 ||
    wordParts[0].type !== "ParameterExpansion" ||
    (wordParts[0].parameter !== "@" && wordParts[0].parameter !== "*") ||
    wordParts[0].operation
  ) {
    return null;
  }

  const isStar = wordParts[0].parameter === "*";
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
  if (numParams === 0) {
    return { values: [], quoted: false };
  }

  // Get individual positional parameters
  const params: string[] = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env.get(String(i)) || "");
  }

  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const ifsWhitespaceOnly = isIfsWhitespaceOnly(ctx.state.env);

  let allWords: string[];

  if (isStar) {
    // $* - join params with IFS[0], then split result by IFS
    // HOWEVER: When IFS is empty, bash keeps params separate (like $@) for unquoted $*
    if (ifsEmpty) {
      // Empty IFS - keep params separate (same as $@), filter out empty params
      allWords = params.filter((p) => p !== "");
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = params.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    // $@ - each param is a separate word, then each is subject to IFS splitting
    if (ifsEmpty) {
      // Empty IFS - no splitting, filter out empty params
      allWords = params.filter((p) => p !== "");
    } else if (ifsWhitespaceOnly) {
      // Whitespace-only IFS - empty params are dropped
      allWords = [];
      for (const param of params) {
        if (param === "") {
          continue;
        }
        const parts = splitByIfsForExpansion(param, ifsChars);
        allWords.push(...parts);
      }
    } else {
      // Non-whitespace IFS - preserve empty params EXCEPT trailing ones
      allWords = [];
      for (const param of params) {
        if (param === "") {
          allWords.push("");
        } else {
          const parts = splitByIfsForExpansion(param, ifsChars);
          allWords.push(...parts);
        }
      }
      // Remove trailing empty strings
      while (allWords.length > 0 && allWords[allWords.length - 1] === "") {
        allWords.pop();
      }
    }
  }

  // Apply glob expansion to each word
  return { values: await applyGlobExpansion(ctx, allWords), quoted: false };
}

/**
 * Handle unquoted ${arr[@]} and ${arr[*]} (without operations)
 */
export async function handleUnquotedSimpleArray(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): Promise<UnquotedExpansionResult> {
  if (
    wordParts.length !== 1 ||
    wordParts[0].type !== "ParameterExpansion" ||
    wordParts[0].operation
  ) {
    return null;
  }

  const arrayMatch = wordParts[0].parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
  );
  if (!arrayMatch) {
    return null;
  }

  const arrayName = arrayMatch[1];
  const isStar = arrayMatch[2] === "*";

  // Get array elements
  const elements = getArrayElements(ctx, arrayName);

  // If no array elements, check for scalar (treat as single-element array)
  let values: string[];
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      values = [scalarValue];
    } else {
      return { values: [], quoted: false };
    }
  } else {
    values = elements.map(([, v]) => v);
  }

  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const ifsWhitespaceOnly = isIfsWhitespaceOnly(ctx.state.env);

  let allWords: string[];

  if (isStar) {
    // ${arr[*]} unquoted - join with IFS[0], then split result by IFS
    if (ifsEmpty) {
      // Empty IFS - keep elements separate (same as arr[@]), filter out empty elements
      allWords = values.filter((v) => v !== "");
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = values.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    // ${arr[@]} unquoted - each element is a separate word, then each is subject to IFS splitting
    if (ifsEmpty) {
      // Empty IFS - no splitting, filter out empty elements
      allWords = values.filter((v) => v !== "");
    } else if (ifsWhitespaceOnly) {
      // Whitespace-only IFS - empty elements are dropped
      allWords = [];
      for (const val of values) {
        if (val === "") {
          continue;
        }
        const parts = splitByIfsForExpansion(val, ifsChars);
        allWords.push(...parts);
      }
    } else {
      // Non-whitespace IFS - preserve empty elements
      allWords = [];
      for (const val of values) {
        if (val === "") {
          allWords.push("");
        } else {
          const parts = splitByIfsForExpansion(val, ifsChars);
          allWords.push(...parts);
        }
      }
      // Remove trailing empty strings
      while (allWords.length > 0 && allWords[allWords.length - 1] === "") {
        allWords.pop();
      }
    }
  }

  // Apply glob expansion to each word
  return { values: await applyGlobExpansion(ctx, allWords), quoted: false };
}

/**
 * Handle unquoted ${!prefix@} and ${!prefix*} (variable name prefix expansion)
 */
export function handleUnquotedVarNamePrefix(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): UnquotedExpansionResult {
  if (
    wordParts.length !== 1 ||
    wordParts[0].type !== "ParameterExpansion" ||
    wordParts[0].operation?.type !== "VarNamePrefix"
  ) {
    return null;
  }

  const op = wordParts[0].operation as {
    type: "VarNamePrefix";
    prefix: string;
    star: boolean;
  };
  const matchingVars = getVarNamesWithPrefix(ctx, op.prefix);

  if (matchingVars.length === 0) {
    return { values: [], quoted: false };
  }

  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);

  let allWords: string[];

  if (op.star) {
    // ${!prefix*} unquoted - join with IFS[0], then split result by IFS
    if (ifsEmpty) {
      // Empty IFS - keep names separate
      allWords = matchingVars;
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = matchingVars.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    // ${!prefix@} unquoted - each name is a separate word, then each is subject to IFS splitting
    if (ifsEmpty) {
      // Empty IFS - no splitting
      allWords = matchingVars;
    } else {
      allWords = [];
      for (const name of matchingVars) {
        const parts = splitByIfsForExpansion(name, ifsChars);
        allWords.push(...parts);
      }
    }
  }

  return { values: allWords, quoted: false };
}

/**
 * Handle unquoted ${!arr[@]} and ${!arr[*]} (array keys/indices expansion)
 */
export function handleUnquotedArrayKeys(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): UnquotedExpansionResult {
  if (
    wordParts.length !== 1 ||
    wordParts[0].type !== "ParameterExpansion" ||
    wordParts[0].operation?.type !== "ArrayKeys"
  ) {
    return null;
  }

  const op = wordParts[0].operation as {
    type: "ArrayKeys";
    array: string;
    star: boolean;
  };
  const elements = getArrayElements(ctx, op.array);
  const keys = elements.map(([k]) => String(k));

  if (keys.length === 0) {
    return { values: [], quoted: false };
  }

  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);

  let allWords: string[];

  if (op.star) {
    // ${!arr[*]} unquoted - join with IFS[0], then split result by IFS
    if (ifsEmpty) {
      // Empty IFS - keep keys separate
      allWords = keys;
    } else {
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = keys.join(ifsSep);
      allWords = splitByIfsForExpansion(joined, ifsChars);
    }
  } else {
    // ${!arr[@]} unquoted - each key is a separate word, then each is subject to IFS splitting
    if (ifsEmpty) {
      // Empty IFS - no splitting
      allWords = keys;
    } else {
      allWords = [];
      for (const key of keys) {
        const parts = splitByIfsForExpansion(key, ifsChars);
        allWords.push(...parts);
      }
    }
  }

  return { values: allWords, quoted: false };
}

/**
 * Handle unquoted $@ or $* with prefix/suffix (e.g., =$@= or =$*=)
 */
export async function handleUnquotedPositionalWithPrefixSuffix(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  expandPart: ExpandPartFn
): Promise<UnquotedExpansionResult> {
  let unquotedAtStarIndex = -1;
  for (let i = 0; i < wordParts.length; i++) {
    const p = wordParts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.parameter === "@" || p.parameter === "*") &&
      !p.operation
    ) {
      unquotedAtStarIndex = i;
      break;
    }
  }

  if (unquotedAtStarIndex === -1 || wordParts.length <= 1) {
    return null;
  }

  // Get positional parameters
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
  const params: string[] = [];
  for (let i = 1; i <= numParams; i++) {
    params.push(ctx.state.env.get(String(i)) || "");
  }

  // Expand prefix (parts before $@/$*)
  let prefix = "";
  for (let i = 0; i < unquotedAtStarIndex; i++) {
    prefix += await expandPart(ctx, wordParts[i]);
  }

  // Expand suffix (parts after $@/$*)
  let suffix = "";
  for (let i = unquotedAtStarIndex + 1; i < wordParts.length; i++) {
    suffix += await expandPart(ctx, wordParts[i]);
  }

  const ifsChars = getIfs(ctx.state.env);
  const ifsEmpty = isIfsEmpty(ctx.state.env);
  const ifsWhitespaceOnly = isIfsWhitespaceOnly(ctx.state.env);

  if (numParams === 0) {
    // No params - just return prefix+suffix if non-empty
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: false };
  }

  // Build words first: prefix joins with first param, suffix joins with last
  let words: string[];

  // Both unquoted $@ and unquoted $* behave the same way:
  // Each param becomes a separate word, then each is subject to IFS splitting.
  {
    // First, attach prefix to first param, suffix to last param
    const rawWords: string[] = [];
    for (let i = 0; i < params.length; i++) {
      let word = params[i];
      if (i === 0) word = prefix + word;
      if (i === params.length - 1) word = word + suffix;
      rawWords.push(word);
    }

    // Now apply IFS splitting and filtering
    if (ifsEmpty) {
      // Empty IFS - no splitting, filter out empty words
      words = rawWords.filter((w) => w !== "");
    } else if (ifsWhitespaceOnly) {
      // Whitespace-only IFS - empty words are dropped
      words = [];
      for (const word of rawWords) {
        if (word === "") continue;
        const parts = splitByIfsForExpansion(word, ifsChars);
        words.push(...parts);
      }
    } else {
      // Non-whitespace IFS - preserve empty words (except trailing)
      words = [];
      for (const word of rawWords) {
        if (word === "") {
          words.push("");
        } else {
          const parts = splitByIfsForExpansion(word, ifsChars);
          words.push(...parts);
        }
      }
      // Remove trailing empty strings
      while (words.length > 0 && words[words.length - 1] === "") {
        words.pop();
      }
    }
  }

  // Apply glob expansion to each word
  if (words.length === 0) {
    return { values: [], quoted: false };
  }

  return { values: await applyGlobExpansion(ctx, words), quoted: false };
}
