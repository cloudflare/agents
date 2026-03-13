/**
 * Array Expansion with Prefix/Suffix Handlers
 *
 * Handles array expansions that have adjacent text in double quotes:
 * - "${prefix}${arr[@]#pattern}${suffix}" - pattern removal with prefix/suffix
 * - "${prefix}${arr[@]/pattern/replacement}${suffix}" - pattern replacement with prefix/suffix
 * - "${prefix}${arr[@]}${suffix}" - simple array expansion with prefix/suffix
 * - "${arr[@]:-${default[@]}}" - array default/alternative values
 */

import type {
  PatternRemovalOp,
  PatternReplacementOp,
  WordNode,
  WordPart
} from "../../ast/types";
import { createUserRegex } from "../../regex/index";
import { getIfsSeparator } from "../helpers/ifs";
import { escapeRegex } from "../helpers/regex";
import type { InterpreterContext } from "../types";
import { patternToRegex } from "./pattern";
import { applyPatternRemoval } from "./pattern-removal";
import { getArrayElements, getVariable, isVariableSet } from "./variable";

/**
 * Result type for array expansion handlers.
 * `null` means the handler doesn't apply to this case.
 */
export type ArrayExpansionResult = { values: string[]; quoted: boolean } | null;

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
 * Handle "${arr[@]:-${default[@]}}", "${arr[@]:+${alt[@]}}", and "${arr[@]:=default}"
 * Also handles "${var:-${default[@]}}" where var is a scalar variable.
 * When the default value contains an array expansion, each element should become a separate word.
 */
export async function handleArrayDefaultValue(
  ctx: InterpreterContext,
  wordParts: WordPart[]
): Promise<ArrayExpansionResult> {
  if (wordParts.length !== 1 || wordParts[0].type !== "DoubleQuoted") {
    return null;
  }

  const dqPart = wordParts[0];
  if (
    dqPart.parts.length !== 1 ||
    dqPart.parts[0].type !== "ParameterExpansion" ||
    (dqPart.parts[0].operation?.type !== "DefaultValue" &&
      dqPart.parts[0].operation?.type !== "UseAlternative" &&
      dqPart.parts[0].operation?.type !== "AssignDefault")
  ) {
    return null;
  }

  const paramPart = dqPart.parts[0];
  const op = paramPart.operation as
    | { type: "DefaultValue"; word?: WordNode; checkEmpty?: boolean }
    | { type: "UseAlternative"; word?: WordNode; checkEmpty?: boolean }
    | { type: "AssignDefault"; word?: WordNode; checkEmpty?: boolean };

  // Check if the outer parameter is an array subscript
  const arrayMatch = paramPart.parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
  );

  // Determine if we should use the alternate/default value
  let shouldUseAlternate: boolean;
  let outerIsStar = false;

  if (arrayMatch) {
    // Outer parameter is an array subscript like arr[@] or arr[*]
    const arrayName = arrayMatch[1];
    outerIsStar = arrayMatch[2] === "*";

    const elements = getArrayElements(ctx, arrayName);
    const isSet = elements.length > 0 || ctx.state.env.has(arrayName);
    const isEmpty =
      elements.length === 0 ||
      (elements.length === 1 && elements.every(([, v]) => v === ""));
    const checkEmpty = op.checkEmpty ?? false;

    if (op.type === "UseAlternative") {
      shouldUseAlternate = isSet && !(checkEmpty && isEmpty);
    } else {
      shouldUseAlternate = !isSet || (checkEmpty && isEmpty);
    }

    // If not using alternate, return the original array value
    if (!shouldUseAlternate) {
      if (elements.length > 0) {
        const values = elements.map(([, v]) => v);
        if (outerIsStar) {
          const ifsSep = getIfsSeparator(ctx.state.env);
          return { values: [values.join(ifsSep)], quoted: true };
        }
        return { values, quoted: true };
      }
      const scalarValue = ctx.state.env.get(arrayName);
      if (scalarValue !== undefined) {
        return { values: [scalarValue], quoted: true };
      }
      return { values: [], quoted: true };
    }
  } else {
    // Outer parameter is a scalar variable
    const varName = paramPart.parameter;
    const isSet = await isVariableSet(ctx, varName);
    const varValue = await getVariable(ctx, varName);
    const isEmpty = varValue === "";
    const checkEmpty = op.checkEmpty ?? false;

    if (op.type === "UseAlternative") {
      shouldUseAlternate = isSet && !(checkEmpty && isEmpty);
    } else {
      shouldUseAlternate = !isSet || (checkEmpty && isEmpty);
    }

    // If not using alternate, return the scalar value
    if (!shouldUseAlternate) {
      return { values: [varValue], quoted: true };
    }
  }

  // We should use the alternate/default value
  if (shouldUseAlternate && op.word) {
    // Check if the default/alternative word contains an array expansion
    const opWordParts = op.word.parts;
    let defaultArrayName: string | null = null;
    let defaultIsStar = false;

    for (const part of opWordParts) {
      if (part.type === "ParameterExpansion" && !part.operation) {
        const defaultMatch = part.parameter.match(
          /^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/
        );
        if (defaultMatch) {
          defaultArrayName = defaultMatch[1];
          defaultIsStar = defaultMatch[2] === "*";
          break;
        }
      }
    }

    if (defaultArrayName) {
      // The default word is an array expansion - return its elements
      const defaultElements = getArrayElements(ctx, defaultArrayName);
      if (defaultElements.length > 0) {
        const values = defaultElements.map(([, v]) => v);
        if (defaultIsStar || outerIsStar) {
          // Join with IFS for [*] subscript
          const ifsSep = getIfsSeparator(ctx.state.env);
          return { values: [values.join(ifsSep)], quoted: true };
        }
        // [@] - each element as a separate word
        return { values, quoted: true };
      }
      // Default array is empty - check for scalar
      const scalarValue = ctx.state.env.get(defaultArrayName);
      if (scalarValue !== undefined) {
        return { values: [scalarValue], quoted: true };
      }
      // Default is unset
      return { values: [], quoted: true };
    }
    // Default word doesn't contain an array expansion - fall through to normal expansion
  }

  return null;
}

/**
 * Handle "${prefix}${arr[@]#pattern}${suffix}" and "${prefix}${arr[@]/pat/rep}${suffix}"
 * Array pattern operations with adjacent text in double quotes.
 * Each array element has the pattern applied, then becomes a separate word
 * with prefix joined to first and suffix joined to last.
 */
export async function handleArrayPatternWithPrefixSuffix(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  hasArrayAtExpansion: boolean,
  expandPart: ExpandPartFn,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<ArrayExpansionResult> {
  if (
    !hasArrayAtExpansion ||
    wordParts.length !== 1 ||
    wordParts[0].type !== "DoubleQuoted"
  ) {
    return null;
  }

  const dqPart = wordParts[0];
  // Find if there's a ${arr[@]} or ${arr[*]} with PatternRemoval or PatternReplacement
  let arrayAtIndex = -1;
  let arrayName = "";
  let isStar = false;
  let arrayOperation: PatternRemovalOp | PatternReplacementOp | null = null;

  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (
      p.type === "ParameterExpansion" &&
      (p.operation?.type === "PatternRemoval" ||
        p.operation?.type === "PatternReplacement")
    ) {
      const match = p.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
      if (match) {
        arrayAtIndex = i;
        arrayName = match[1];
        isStar = match[2] === "*";
        arrayOperation = p.operation as PatternRemovalOp | PatternReplacementOp;
        break;
      }
    }
  }

  // Only handle if there's prefix or suffix (pure "${arr[@]#pat}" is handled elsewhere)
  if (
    arrayAtIndex === -1 ||
    (arrayAtIndex === 0 && arrayAtIndex === dqPart.parts.length - 1)
  ) {
    return null;
  }

  // Expand prefix (parts before ${arr[@]})
  let prefix = "";
  for (let i = 0; i < arrayAtIndex; i++) {
    prefix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Expand suffix (parts after ${arr[@]})
  let suffix = "";
  for (let i = arrayAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Get array elements
  const elements = getArrayElements(ctx, arrayName);
  let values = elements.map(([, v]) => v);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      values = [scalarValue];
    } else {
      // Variable is unset or empty array
      if (isStar) {
        return { values: [prefix + suffix], quoted: true };
      }
      const combined = prefix + suffix;
      return { values: combined ? [combined] : [], quoted: true };
    }
  }

  // Apply operation to each element
  if (arrayOperation?.type === "PatternRemoval") {
    const op = arrayOperation as PatternRemovalOp;
    // Build the regex pattern
    let regexStr = "";
    const extglob = ctx.state.shoptOptions.extglob;
    if (op.pattern) {
      for (const part of op.pattern.parts) {
        if (part.type === "Glob") {
          regexStr += patternToRegex(part.pattern, op.greedy, extglob);
        } else if (part.type === "Literal") {
          regexStr += patternToRegex(part.value, op.greedy, extglob);
        } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
          regexStr += escapeRegex(part.value);
        } else if (part.type === "DoubleQuoted") {
          const expanded = await expandWordPartsAsync(ctx, part.parts);
          regexStr += escapeRegex(expanded);
        } else if (part.type === "ParameterExpansion") {
          const expanded = await expandPart(ctx, part);
          regexStr += patternToRegex(expanded, op.greedy, extglob);
        } else {
          const expanded = await expandPart(ctx, part);
          regexStr += escapeRegex(expanded);
        }
      }
    }
    // Apply pattern removal to each element
    values = values.map((value) =>
      applyPatternRemoval(value, regexStr, op.side, op.greedy)
    );
  } else if (arrayOperation?.type === "PatternReplacement") {
    const op = arrayOperation as PatternReplacementOp;
    // Build the replacement regex
    let regex = "";
    if (op.pattern) {
      for (const part of op.pattern.parts) {
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
          regex += patternToRegex(
            expanded,
            true,
            ctx.state.shoptOptions.extglob
          );
        } else {
          const expanded = await expandPart(ctx, part);
          regex += escapeRegex(expanded);
        }
      }
    }

    const replacement = op.replacement
      ? await expandWordPartsAsync(ctx, op.replacement.parts)
      : "";

    // Apply anchor modifiers
    let regexPattern = regex;
    if (op.anchor === "start") {
      regexPattern = `^${regex}`;
    } else if (op.anchor === "end") {
      regexPattern = `${regex}$`;
    }

    // Apply replacement to each element
    try {
      const re = createUserRegex(regexPattern, op.all ? "g" : "");
      values = values.map((value) => re.replace(value, replacement));
    } catch {
      // Invalid regex - leave values unchanged
    }
  }

  if (isStar) {
    // "${arr[*]#...}" - join all elements with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + values.join(ifsSep) + suffix],
      quoted: true
    };
  }

  // "${arr[@]#...}" - each element is a separate word
  // Join prefix with first, suffix with last
  if (values.length === 1) {
    return { values: [prefix + values[0] + suffix], quoted: true };
  }

  const result = [
    prefix + values[0],
    ...values.slice(1, -1),
    values[values.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}

/**
 * Handle "${prefix}${arr[@]}${suffix}" - array expansion with adjacent text in double quotes.
 * Each array element becomes a separate word, with prefix joined to first and suffix joined to last.
 * This is similar to how "$@" works with prefix/suffix.
 */
export async function handleArrayWithPrefixSuffix(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  hasArrayAtExpansion: boolean,
  expandPart: ExpandPartFn
): Promise<ArrayExpansionResult> {
  if (
    !hasArrayAtExpansion ||
    wordParts.length !== 1 ||
    wordParts[0].type !== "DoubleQuoted"
  ) {
    return null;
  }

  const dqPart = wordParts[0];
  // Find if there's a ${arr[@]} or ${arr[*]} inside (without operations)
  let arrayAtIndex = -1;
  let arrayName = "";
  let isStar = false;

  for (let i = 0; i < dqPart.parts.length; i++) {
    const p = dqPart.parts[i];
    if (p.type === "ParameterExpansion" && !p.operation) {
      const match = p.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
      if (match) {
        arrayAtIndex = i;
        arrayName = match[1];
        isStar = match[2] === "*";
        break;
      }
    }
  }

  if (arrayAtIndex === -1) {
    return null;
  }

  // Expand prefix (parts before ${arr[@]})
  let prefix = "";
  for (let i = 0; i < arrayAtIndex; i++) {
    prefix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Expand suffix (parts after ${arr[@]})
  let suffix = "";
  for (let i = arrayAtIndex + 1; i < dqPart.parts.length; i++) {
    suffix += await expandPart(ctx, dqPart.parts[i]);
  }

  // Get array elements
  const elements = getArrayElements(ctx, arrayName);
  const values = elements.map(([, v]) => v);

  // If no elements, check for scalar (treat as single-element array)
  if (elements.length === 0) {
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      // Scalar treated as single-element array
      return { values: [prefix + scalarValue + suffix], quoted: true };
    }
    // Variable is unset or empty array
    if (isStar) {
      // "${arr[*]}" with empty array produces one empty word (prefix + "" + suffix)
      return { values: [prefix + suffix], quoted: true };
    }
    // "${arr[@]}" with empty array produces no words (unless there's prefix/suffix)
    const combined = prefix + suffix;
    return { values: combined ? [combined] : [], quoted: true };
  }

  if (isStar) {
    // "${arr[*]}" - join all elements with IFS into one word
    const ifsSep = getIfsSeparator(ctx.state.env);
    return {
      values: [prefix + values.join(ifsSep) + suffix],
      quoted: true
    };
  }

  // "${arr[@]}" - each element is a separate word
  // Join prefix with first, suffix with last
  if (values.length === 1) {
    return { values: [prefix + values[0] + suffix], quoted: true };
  }

  const result = [
    prefix + values[0],
    ...values.slice(1, -1),
    values[values.length - 1] + suffix
  ];
  return { values: result, quoted: true };
}
