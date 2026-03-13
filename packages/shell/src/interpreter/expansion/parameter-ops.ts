/**
 * Parameter Operation Handlers
 *
 * Handles individual parameter expansion operations:
 * - DefaultValue, AssignDefault, UseAlternative, ErrorIfUnset
 * - PatternRemoval, PatternReplacement
 * - Length, Substring
 * - CaseModification, Transform
 * - Indirection, ArrayKeys, VarNamePrefix
 */

import type {
  CaseModificationOp,
  ErrorIfUnsetOp,
  InnerParameterOperation,
  ParameterExpansionPart,
  PatternRemovalOp,
  PatternReplacementOp,
  SubstringOp,
  WordNode,
  WordPart
} from "../../ast/types";
import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import { createUserRegex } from "../../regex/index";
import { evaluateArithmetic } from "../arithmetic";
import {
  ArithmeticError,
  BadSubstitutionError,
  ExecutionLimitError,
  ExitError
} from "../errors";
import { getIfsSeparator } from "../helpers/ifs";
import { getNamerefTarget, isNameref } from "../helpers/nameref";
import { escapeRegex } from "../helpers/regex";
import type { InterpreterContext } from "../types";
import { patternToRegex } from "./pattern";
import { getVarNamesWithPrefix } from "./pattern-removal";
import { expandPrompt } from "./prompt";
import { quoteValue } from "./quoting";
import { getArrayElements, getVariable, isArray } from "./variable";
import { getVariableAttributes } from "./variable-attrs";

/**
 * Type for expandWordPartsAsync function reference
 */
export type ExpandWordPartsAsyncFn = (
  ctx: InterpreterContext,
  parts: WordPart[],
  inDoubleQuotes?: boolean
) => Promise<string>;

/**
 * Type for expandPart function reference
 */
export type ExpandPartFn = (
  ctx: InterpreterContext,
  part: WordPart,
  inDoubleQuotes?: boolean
) => Promise<string>;

/**
 * Type for self-reference to expandParameterAsync
 */
export type ExpandParameterAsyncFn = (
  ctx: InterpreterContext,
  part: ParameterExpansionPart,
  inDoubleQuotes?: boolean
) => Promise<string>;

/**
 * Context with computed values used across multiple operation handlers
 */
export interface ParameterOpContext {
  value: string;
  isUnset: boolean;
  isEmpty: boolean;
  effectiveValue: string;
  inDoubleQuotes: boolean;
}

/**
 * Handle DefaultValue operation: ${param:-word}
 */
export async function handleDefaultValue(
  ctx: InterpreterContext,
  operation: { word?: WordNode; checkEmpty?: boolean },
  opCtx: ParameterOpContext,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<string> {
  const useDefault = opCtx.isUnset || (operation.checkEmpty && opCtx.isEmpty);
  if (useDefault && operation.word) {
    return expandWordPartsAsync(
      ctx,
      operation.word.parts,
      opCtx.inDoubleQuotes
    );
  }
  return opCtx.effectiveValue;
}

/**
 * Handle AssignDefault operation: ${param:=word}
 */
export async function handleAssignDefault(
  ctx: InterpreterContext,
  parameter: string,
  operation: { word?: WordNode; checkEmpty?: boolean },
  opCtx: ParameterOpContext,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<string> {
  const useDefault = opCtx.isUnset || (operation.checkEmpty && opCtx.isEmpty);
  if (useDefault && operation.word) {
    const defaultValue = await expandWordPartsAsync(
      ctx,
      operation.word.parts,
      opCtx.inDoubleQuotes
    );
    // Handle array subscript assignment (e.g., arr[0]=x)
    const arrayMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
    if (arrayMatch) {
      const [, arrayName, subscriptExpr] = arrayMatch;
      // Evaluate subscript as arithmetic expression
      let index: number;
      if (/^\d+$/.test(subscriptExpr)) {
        index = Number.parseInt(subscriptExpr, 10);
      } else {
        try {
          const parser = new Parser();
          const arithAst = parseArithmeticExpression(parser, subscriptExpr);
          index = await evaluateArithmetic(ctx, arithAst.expression);
        } catch {
          const varValue = ctx.state.env.get(subscriptExpr);
          index = varValue ? Number.parseInt(varValue, 10) : 0;
        }
        if (Number.isNaN(index)) index = 0;
      }
      // Set array element
      ctx.state.env.set(`${arrayName}_${index}`, defaultValue);
      // Update array length if needed
      const currentLength = Number.parseInt(
        ctx.state.env.get(`${arrayName}__length`) || "0",
        10
      );
      if (index >= currentLength) {
        ctx.state.env.set(`${arrayName}__length`, String(index + 1));
      }
    } else {
      ctx.state.env.set(parameter, defaultValue);
    }
    return defaultValue;
  }
  return opCtx.effectiveValue;
}

/**
 * Handle ErrorIfUnset operation: ${param:?word}
 */
export async function handleErrorIfUnset(
  ctx: InterpreterContext,
  parameter: string,
  operation: ErrorIfUnsetOp,
  opCtx: ParameterOpContext,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<string> {
  const shouldError = opCtx.isUnset || (operation.checkEmpty && opCtx.isEmpty);
  if (shouldError) {
    const message = operation.word
      ? await expandWordPartsAsync(
          ctx,
          operation.word.parts,
          opCtx.inDoubleQuotes
        )
      : `${parameter}: parameter null or not set`;
    throw new ExitError(1, "", `bash: ${message}\n`);
  }
  return opCtx.effectiveValue;
}

/**
 * Handle UseAlternative operation: ${param:+word}
 */
export async function handleUseAlternative(
  ctx: InterpreterContext,
  operation: { word?: WordNode; checkEmpty?: boolean },
  opCtx: ParameterOpContext,
  expandWordPartsAsync: ExpandWordPartsAsyncFn
): Promise<string> {
  const useAlternative = !(
    opCtx.isUnset ||
    (operation.checkEmpty && opCtx.isEmpty)
  );
  if (useAlternative && operation.word) {
    return expandWordPartsAsync(
      ctx,
      operation.word.parts,
      opCtx.inDoubleQuotes
    );
  }
  return "";
}

/**
 * Handle PatternRemoval operation: ${param#pattern}, ${param%pattern}
 */
export async function handlePatternRemoval(
  ctx: InterpreterContext,
  value: string,
  operation: PatternRemovalOp,
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<string> {
  // Build regex pattern from parts, preserving literal vs glob distinction
  let regexStr = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regexStr += patternToRegex(part.pattern, operation.greedy, extglob);
      } else if (part.type === "Literal") {
        // Unquoted literal - treat as glob pattern (may contain *, ?, [...])
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

  // Use 's' flag (dotall) so that . matches newlines (bash ? matches any char including newline)
  if (operation.side === "prefix") {
    return createUserRegex(`^${regexStr}`, "s").replace(value, "");
  }
  const regex = createUserRegex(`${regexStr}$`, "s");
  if (operation.greedy) {
    return regex.replace(value, "");
  }
  for (let i = value.length; i >= 0; i--) {
    const suffix = value.slice(i);
    if (regex.test(suffix)) {
      return value.slice(0, i);
    }
  }
  return value;
}

/**
 * Handle PatternReplacement operation: ${param/pattern/replacement}
 */
export async function handlePatternReplacement(
  ctx: InterpreterContext,
  value: string,
  operation: PatternReplacementOp,
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandPart: ExpandPartFn
): Promise<string> {
  let regex = "";
  const extglob = ctx.state.shoptOptions.extglob;
  if (operation.pattern) {
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        regex += patternToRegex(part.pattern, true, extglob);
      } else if (part.type === "Literal") {
        // Unquoted literal - treat as glob pattern (may contain *, ?, [...], \X)
        regex += patternToRegex(part.value, true, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        regex += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync(ctx, part.parts);
        regex += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandPart(ctx, part);
        regex += patternToRegex(expanded, true, extglob);
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
  if (operation.anchor === "start") {
    regex = `^${regex}`;
  } else if (operation.anchor === "end") {
    regex = `${regex}$`;
  }

  // Empty pattern (without anchor) means no replacement - return original value
  // But with anchor, empty pattern is valid: ${var/#/prefix} prepends, ${var/%/suffix} appends
  if (regex === "") {
    return value;
  }

  // Use 's' flag (dotall) so that . matches newlines (bash ? and * match any char including newline)
  const flags = operation.all ? "gs" : "s";

  try {
    const re = createUserRegex(regex, flags);
    if (operation.all) {
      let result = "";
      let lastIndex = 0;
      let iterCount = 0;
      const maxStringLen = ctx.limits.maxStringLength;
      let match: RegExpExecArray | null = re.exec(value);
      while (match !== null) {
        if (match[0].length === 0 && match.index === value.length) {
          break;
        }
        result += value.slice(lastIndex, match.index) + replacement;
        lastIndex = match.index + match[0].length;
        if (match[0].length === 0) {
          lastIndex++;
        }
        // Check string length every 100 iterations to catch runaway growth
        iterCount++;
        if (iterCount % 100 === 0 && result.length > maxStringLen) {
          throw new ExecutionLimitError(
            `pattern replacement: string length limit exceeded (${maxStringLen} bytes)`,
            "string_length"
          );
        }
        match = re.exec(value);
      }
      result += value.slice(lastIndex);
      return result;
    }
    return re.replace(value, replacement);
  } catch (e) {
    if (e instanceof ExecutionLimitError) {
      throw e;
    }
    return value;
  }
}

/**
 * Handle Length operation: ${#param}
 */
export function handleLength(
  ctx: InterpreterContext,
  parameter: string,
  value: string
): string {
  // Check if this is an array length: ${#a[@]} or ${#a[*]}
  const arrayMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/);
  if (arrayMatch) {
    const arrayName = arrayMatch[1];
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length > 0) {
      return String(elements.length);
    }
    // If no array elements, check if scalar variable exists
    // In bash, ${#s[@]} for scalar s returns 1
    const scalarValue = ctx.state.env.get(arrayName);
    if (scalarValue !== undefined) {
      return "1";
    }
    return "0";
  }
  // Check if this is just the array name (decays to ${#a[0]})
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parameter) && isArray(ctx, parameter)) {
    // Special handling for FUNCNAME and BASH_LINENO
    if (parameter === "FUNCNAME") {
      const firstElement = ctx.state.funcNameStack?.[0] || "";
      return String([...firstElement].length);
    }
    if (parameter === "BASH_LINENO") {
      const firstElement = ctx.state.callLineStack?.[0];
      return String(
        firstElement !== undefined ? [...String(firstElement)].length : 0
      );
    }
    const firstElement = ctx.state.env.get(`${parameter}_0`) || "";
    return String([...firstElement].length);
  }
  // Use spread to count Unicode code points, not UTF-16 code units
  return String([...value].length);
}

/**
 * Handle Substring operation: ${param:offset:length}
 */
export async function handleSubstring(
  ctx: InterpreterContext,
  parameter: string,
  value: string,
  operation: SubstringOp
): Promise<string> {
  const offset = await evaluateArithmetic(ctx, operation.offset.expression);
  const length = operation.length
    ? await evaluateArithmetic(ctx, operation.length.expression)
    : undefined;

  // Handle special case for ${@:offset} and ${*:offset}
  if (parameter === "@" || parameter === "*") {
    const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
    const params: string[] = [];
    for (let i = 1; i <= numParams; i++) {
      params.push(ctx.state.env.get(String(i)) || "");
    }
    const shellName = ctx.state.env.get("0") || "bash";
    let allArgs: string[];
    let startIdx: number;

    if (offset <= 0) {
      allArgs = [shellName, ...params];
      if (offset < 0) {
        startIdx = allArgs.length + offset;
        if (startIdx < 0) return "";
      } else {
        startIdx = 0;
      }
    } else {
      allArgs = params;
      startIdx = offset - 1;
    }

    if (startIdx < 0 || startIdx >= allArgs.length) {
      return "";
    }
    if (length !== undefined) {
      const endIdx = length < 0 ? allArgs.length + length : startIdx + length;
      return allArgs.slice(startIdx, Math.max(startIdx, endIdx)).join(" ");
    }
    return allArgs.slice(startIdx).join(" ");
  }

  // Handle array slicing: ${arr[@]:offset} or ${arr[*]:offset}
  const arrayMatchSubstr = parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/
  );
  if (arrayMatchSubstr) {
    const arrayName = arrayMatchSubstr[1];
    if (ctx.state.associativeArrays?.has(arrayName)) {
      throw new ExitError(
        1,
        "",
        `bash: \${${arrayName}[@]: 0: 3}: bad substitution\n`
      );
    }
    const elements = getArrayElements(ctx, arrayName);
    let startIdx = 0;
    if (offset < 0) {
      if (elements.length > 0) {
        const lastIdx = elements[elements.length - 1][0];
        const maxIndex = typeof lastIdx === "number" ? lastIdx : 0;
        const targetIndex = maxIndex + 1 + offset;
        if (targetIndex < 0) return "";
        startIdx = elements.findIndex(
          ([idx]) => typeof idx === "number" && idx >= targetIndex
        );
        if (startIdx < 0) return "";
      }
    } else {
      startIdx = elements.findIndex(
        ([idx]) => typeof idx === "number" && idx >= offset
      );
      if (startIdx < 0) return "";
    }

    if (length !== undefined) {
      if (length < 0) {
        throw new ArithmeticError(
          `${arrayMatchSubstr[1]}[@]: substring expression < 0`
        );
      }
      return elements
        .slice(startIdx, startIdx + length)
        .map(([, v]) => v)
        .join(" ");
    }
    return elements
      .slice(startIdx)
      .map(([, v]) => v)
      .join(" ");
  }

  // String slicing with UTF-8 support
  const chars = [...value];
  let start = offset;
  if (start < 0) start = Math.max(0, chars.length + start);
  if (length !== undefined) {
    if (length < 0) {
      const endPos = chars.length + length;
      return chars.slice(start, Math.max(start, endPos)).join("");
    }
    return chars.slice(start, start + length).join("");
  }
  return chars.slice(start).join("");
}

/**
 * Handle CaseModification operation: ${param^pattern}, ${param,pattern}
 */
export async function handleCaseModification(
  ctx: InterpreterContext,
  value: string,
  operation: CaseModificationOp,
  expandWordPartsAsync: ExpandWordPartsAsyncFn,
  expandParameterAsync: ExpandParameterAsyncFn
): Promise<string> {
  if (operation.pattern) {
    const extglob = ctx.state.shoptOptions.extglob;
    let patternRegexStr = "";
    for (const part of operation.pattern.parts) {
      if (part.type === "Glob") {
        patternRegexStr += patternToRegex(part.pattern, true, extglob);
      } else if (part.type === "Literal") {
        patternRegexStr += patternToRegex(part.value, true, extglob);
      } else if (part.type === "SingleQuoted" || part.type === "Escaped") {
        patternRegexStr += escapeRegex(part.value);
      } else if (part.type === "DoubleQuoted") {
        const expanded = await expandWordPartsAsync(ctx, part.parts);
        patternRegexStr += escapeRegex(expanded);
      } else if (part.type === "ParameterExpansion") {
        const expanded = await expandParameterAsync(ctx, part);
        patternRegexStr += patternToRegex(expanded, true, extglob);
      }
    }
    const charPattern = createUserRegex(`^(?:${patternRegexStr})$`);
    const transform =
      operation.direction === "upper"
        ? (c: string) => c.toUpperCase()
        : (c: string) => c.toLowerCase();

    let result = "";
    let converted = false;
    for (const char of value) {
      if (!operation.all && converted) {
        result += char;
      } else if (charPattern.test(char)) {
        result += transform(char);
        converted = true;
      } else {
        result += char;
      }
    }
    return result;
  }

  if (operation.direction === "upper") {
    return operation.all
      ? value.toUpperCase()
      : value.charAt(0).toUpperCase() + value.slice(1);
  }
  return operation.all
    ? value.toLowerCase()
    : value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Handle Transform operation: ${param@operator}
 */
export function handleTransform(
  ctx: InterpreterContext,
  parameter: string,
  value: string,
  isUnset: boolean,
  operation: { operator: string }
): string {
  const arrayMatchTransform = parameter.match(
    /^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/
  );
  if (arrayMatchTransform && operation.operator === "Q") {
    const elements = getArrayElements(ctx, arrayMatchTransform[1]);
    const quotedElements = elements.map(([, v]) => quoteValue(v));
    return quotedElements.join(" ");
  }
  if (arrayMatchTransform && operation.operator === "a") {
    return getVariableAttributes(ctx, arrayMatchTransform[1]);
  }

  const arrayElemMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[.+\]$/);
  if (arrayElemMatch && operation.operator === "a") {
    return getVariableAttributes(ctx, arrayElemMatch[1]);
  }

  switch (operation.operator) {
    case "Q":
      if (isUnset) return "";
      return quoteValue(value);
    case "P":
      return expandPrompt(ctx, value);
    case "a":
      return getVariableAttributes(ctx, parameter);
    case "A":
      if (isUnset) return "";
      return `${parameter}=${quoteValue(value)}`;
    case "E":
      return value.replace(/\\([\\abefnrtv'"?])/g, (_, c) => {
        switch (c) {
          case "\\":
            return "\\";
          case "a":
            return "\x07";
          case "b":
            return "\b";
          case "e":
            return "\x1b";
          case "f":
            return "\f";
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          case "v":
            return "\v";
          case "'":
            return "'";
          case '"':
            return '"';
          case "?":
            return "?";
          default:
            return c;
        }
      });
    case "K":
    case "k":
      if (isUnset) return "";
      return quoteValue(value);
    case "u":
      return value.charAt(0).toUpperCase() + value.slice(1);
    case "U":
      return value.toUpperCase();
    case "L":
      return value.toLowerCase();
    default:
      return value;
  }
}

/**
 * Handle Indirection operation: ${!param}
 */
export async function handleIndirection(
  ctx: InterpreterContext,
  parameter: string,
  value: string,
  isUnset: boolean,
  operation: { innerOp?: InnerParameterOperation },
  expandParameterAsync: ExpandParameterAsyncFn,
  inDoubleQuotes = false
): Promise<string> {
  if (isNameref(ctx, parameter)) {
    return getNamerefTarget(ctx, parameter) || "";
  }

  const isArrayExpansionPattern = /^[a-zA-Z_][a-zA-Z0-9_]*\[([@*])\]$/.test(
    parameter
  );

  if (isUnset) {
    if (operation.innerOp?.type === "UseAlternative") {
      return "";
    }
    throw new BadSubstitutionError(`\${!${parameter}}`);
  }

  const targetName = value;

  if (
    isArrayExpansionPattern &&
    (targetName === "" || targetName.includes(" "))
  ) {
    throw new BadSubstitutionError(`\${!${parameter}}`);
  }

  const arraySubscriptMatch = targetName.match(
    /^[a-zA-Z_][a-zA-Z0-9_]*\[(.+)\]$/
  );
  if (arraySubscriptMatch) {
    const subscript = arraySubscriptMatch[1];
    if (subscript.includes("~")) {
      throw new BadSubstitutionError(`\${!${parameter}}`);
    }
  }

  if (operation.innerOp) {
    const syntheticPart: ParameterExpansionPart = {
      type: "ParameterExpansion",
      parameter: targetName,
      operation: operation.innerOp
    };
    return expandParameterAsync(ctx, syntheticPart, inDoubleQuotes);
  }

  return await getVariable(ctx, targetName);
}

/**
 * Handle ArrayKeys operation: ${!arr[@]}, ${!arr[*]}
 */
export function handleArrayKeys(
  ctx: InterpreterContext,
  operation: { array: string; star: boolean }
): string {
  const elements = getArrayElements(ctx, operation.array);
  const keys = elements.map(([k]) => String(k));
  if (operation.star) {
    return keys.join(getIfsSeparator(ctx.state.env));
  }
  return keys.join(" ");
}

/**
 * Handle VarNamePrefix operation: ${!prefix*}, ${!prefix@}
 */
export function handleVarNamePrefix(
  ctx: InterpreterContext,
  operation: { prefix: string; star: boolean }
): string {
  const matchingVars = getVarNamesWithPrefix(ctx, operation.prefix);
  if (operation.star) {
    return matchingVars.join(getIfsSeparator(ctx.state.env));
  }
  return matchingVars.join(" ");
}

/**
 * Compute whether the parameter value is "empty" for expansion purposes.
 * This handles special cases for $*, $@, array[*], and array[@].
 */
export function computeIsEmpty(
  ctx: InterpreterContext,
  parameter: string,
  value: string,
  inDoubleQuotes: boolean
): { isEmpty: boolean; effectiveValue: string } {
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);

  // Check if this is an array expansion: varname[*] or varname[@]
  const arrayExpMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);

  if (parameter === "*") {
    // $* is only "empty" if no positional params exist
    return { isEmpty: numParams === 0, effectiveValue: value };
  }

  if (parameter === "@") {
    // $@ is "empty" if no params OR exactly one empty param
    return {
      isEmpty:
        numParams === 0 || (numParams === 1 && ctx.state.env.get("1") === ""),
      effectiveValue: value
    };
  }

  if (arrayExpMatch) {
    // a[*] or a[@] - check if expansion is empty considering IFS
    const [, arrayName, subscript] = arrayExpMatch;
    const elements = getArrayElements(ctx, arrayName);
    if (elements.length === 0) {
      // Empty array - always empty
      return { isEmpty: true, effectiveValue: "" };
    }
    if (subscript === "*") {
      // a[*] behavior depends on quoting context:
      // - Quoted "${a[*]:-default}": uses default if IFS-joined result is empty
      // - Unquoted ${a[*]:-default}: like $*, only "empty" if array has no elements
      //   (even if IFS="" makes the joined expansion an empty string)
      const ifsSep = getIfsSeparator(ctx.state.env);
      const joined = elements.map(([, v]) => v).join(ifsSep);
      return {
        isEmpty: inDoubleQuotes ? joined === "" : false,
        effectiveValue: joined // Use IFS-joined value instead of space-joined
      };
    }
    // a[@] - empty only if all elements are empty AND there's exactly one
    // (similar to $@ behavior with single empty param)
    return {
      isEmpty: elements.length === 1 && elements.every(([, v]) => v === ""),
      effectiveValue: elements.map(([, v]) => v).join(" ")
    };
  }

  return { isEmpty: value === "", effectiveValue: value };
}
