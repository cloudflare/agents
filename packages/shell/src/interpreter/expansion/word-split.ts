/**
 * Word Splitting
 *
 * IFS-based word splitting for unquoted expansions.
 */

import type { ParameterExpansionPart, WordPart } from "../../ast/types";
import { getVariable, isVariableSet } from "../expansion/variable";
import { splitByIfsForExpansionEx } from "../helpers/ifs";
import type { InterpreterContext } from "../types";
import {
  globPatternHasVarRef,
  isOperationWordEntirelyQuoted
} from "./analysis";

/**
 * Type for the expandPart function that will be injected
 */
export type ExpandPartFn = (
  ctx: InterpreterContext,
  part: WordPart
) => Promise<string>;

/**
 * Check if a ParameterExpansion with a default/alternative value should use that value.
 * Returns the operation word parts if the value should be used, null otherwise.
 */
async function shouldUseOperationWord(
  ctx: InterpreterContext,
  part: ParameterExpansionPart
): Promise<WordPart[] | null> {
  const op = part.operation;
  if (!op) return null;

  // Only handle DefaultValue, AssignDefault, and UseAlternative
  if (
    op.type !== "DefaultValue" &&
    op.type !== "AssignDefault" &&
    op.type !== "UseAlternative"
  ) {
    return null;
  }

  const word = (op as { word?: { parts: WordPart[] } }).word;
  if (!word || word.parts.length === 0) return null;

  // Check if the variable is set/empty
  // Pass checkNounset=false because we're inside a default/alternative value context
  // where unset variables are allowed
  const isSet = await isVariableSet(ctx, part.parameter);
  const value = await getVariable(ctx, part.parameter, false);
  const isEmpty = value === "";
  const checkEmpty = (op as { checkEmpty?: boolean }).checkEmpty ?? false;

  let shouldUse: boolean;
  if (op.type === "UseAlternative") {
    // ${var+word} - use word if var IS set (and non-empty if :+)
    shouldUse = isSet && !(checkEmpty && isEmpty);
  } else {
    // ${var-word} / ${var=word} - use word if var is NOT set (or empty if :-)
    shouldUse = !isSet || (checkEmpty && isEmpty);
  }

  if (!shouldUse) return null;

  return word.parts;
}

/**
 * Check if a DoubleQuoted part contains only simple literals (no expansions).
 * This is used to determine if special IFS handling is needed.
 */
function isSimpleQuotedLiteral(part: WordPart): boolean {
  if (part.type === "SingleQuoted") {
    return true; // Single quotes always contain only literals
  }
  if (part.type === "DoubleQuoted") {
    const dqPart = part as { parts: WordPart[] };
    // Check that all parts inside the double quotes are literals
    return dqPart.parts.every((p) => p.type === "Literal");
  }
  return false;
}

/**
 * Check if a ParameterExpansion has a default/alternative value with mixed quoted/unquoted parts.
 * These need special handling to preserve quote boundaries during IFS splitting.
 *
 * This function returns non-null only when:
 * 1. The default value has mixed quoted and unquoted parts
 * 2. The quoted parts contain only simple literals (no $@, $*, or other expansions)
 *
 * Cases like ${var:-"$@"x} should NOT use special handling because $@ has special
 * behavior that needs to be preserved.
 */
async function hasMixedQuotedDefaultValue(
  ctx: InterpreterContext,
  part: WordPart
): Promise<WordPart[] | null> {
  if (part.type !== "ParameterExpansion") return null;

  const opWordParts = await shouldUseOperationWord(ctx, part);
  if (!opWordParts || opWordParts.length <= 1) return null;

  // Check if the operation word has simple quoted parts (only literals inside)
  const hasSimpleQuotedParts = opWordParts.some((p) =>
    isSimpleQuotedLiteral(p)
  );
  const hasUnquotedParts = opWordParts.some(
    (p) =>
      p.type === "Literal" ||
      p.type === "ParameterExpansion" ||
      p.type === "CommandSubstitution" ||
      p.type === "ArithmeticExpansion"
  );

  // Only apply special handling when we have simple quoted literals and unquoted parts
  // This handles cases like ${var:-"2_3"x_x"4_5"} where the IFS char should only
  // split at the unquoted underscore, not inside the quoted strings
  if (hasSimpleQuotedParts && hasUnquotedParts) {
    return opWordParts;
  }

  return null;
}

/**
 * Check if a word part is splittable (subject to IFS splitting).
 * Unquoted parameter expansions, command substitutions, and arithmetic expansions
 * are splittable. Quoted parts (DoubleQuoted, SingleQuoted) are NOT splittable.
 */
function isPartSplittable(part: WordPart): boolean {
  // Quoted parts are never splittable
  if (part.type === "DoubleQuoted" || part.type === "SingleQuoted") {
    return false;
  }

  // Literal parts are not splittable (they join with adjacent fields)
  if (part.type === "Literal") {
    return false;
  }

  // Glob parts are splittable only if they contain variable references
  // e.g., +($ABC) where ABC contains IFS characters should be split
  if (part.type === "Glob") {
    return globPatternHasVarRef(part.pattern);
  }

  // Check for splittable expansion types
  const isSplittable =
    part.type === "ParameterExpansion" ||
    part.type === "CommandSubstitution" ||
    part.type === "ArithmeticExpansion";

  if (!isSplittable) {
    return false;
  }

  // Word splitting behavior depends on whether the default value is entirely quoted:
  //
  // - ${v:-"AxBxC"} - entirely quoted default value, should NOT be split
  //   The quotes protect the entire default value from word splitting.
  //
  // - ${v:-x"AxBxC"x} - mixed quoted/unquoted parts, SHOULD be split
  //   The unquoted parts (x) act as potential word boundaries when containing IFS chars.
  //   The quoted part "AxBxC" is protected from internal splitting.
  //
  // - ${v:-AxBxC} - entirely unquoted, SHOULD be split
  //   All IFS chars in the result cause word boundaries.
  //
  // - ${v:-x"$@"x} - contains $@ in quotes with surrounding literals
  //   bash 5.x: word splits the entire result (each space becomes a boundary)
  //   bash 3.2/osh: preserves $@ element boundaries but doesn't add more splits
  //
  // We check isOperationWordEntirelyQuoted: if true, the expansion is non-splittable.
  // If false (mixed or no quotes), word splitting applies.
  if (
    part.type === "ParameterExpansion" &&
    isOperationWordEntirelyQuoted(part)
  ) {
    return false;
  }

  return true;
}

/**
 * Smart word splitting for words containing expansions.
 *
 * In bash, word splitting respects quoted parts. When you have:
 * - $a"$b" where a="1 2" and b="3 4"
 * - The unquoted $a gets split by IFS: "1 2" -> ["1", "2"]
 * - The quoted "$b" does NOT get split, it joins with the last field from $a
 * - Result: ["1", "23 4"] (the "2" joins with "3 4")
 *
 * This differs from pure literal words which are never IFS-split.
 *
 * @param ctx - Interpreter context
 * @param wordParts - Word parts to expand and split
 * @param ifsChars - IFS characters for proper whitespace/non-whitespace handling
 * @param ifsPattern - Regex-escaped IFS pattern for checking if splitting is needed
 * @param expandPartFn - Function to expand individual parts (injected to avoid circular deps)
 */
export async function smartWordSplit(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  ifsChars: string,
  _ifsPattern: string,
  expandPartFn: ExpandPartFn
): Promise<string[]> {
  // Check for special case: ParameterExpansion with a default value that should be used
  // In this case, we need to recursively word-split the default value's parts
  // to preserve quote boundaries within the default value.
  if (wordParts.length === 1 && wordParts[0].type === "ParameterExpansion") {
    const paramPart = wordParts[0];
    const opWordParts = await shouldUseOperationWord(ctx, paramPart);
    if (opWordParts && opWordParts.length > 0) {
      // Check if the operation word has mixed quoted/unquoted parts
      // that would benefit from recursive word splitting
      const hasMixedParts =
        opWordParts.length > 1 &&
        opWordParts.some(
          (p) => p.type === "DoubleQuoted" || p.type === "SingleQuoted"
        ) &&
        opWordParts.some(
          (p) =>
            p.type === "Literal" ||
            p.type === "ParameterExpansion" ||
            p.type === "CommandSubstitution" ||
            p.type === "ArithmeticExpansion"
        );

      if (hasMixedParts) {
        // Recursively word-split the default value's parts
        // But we need special handling: Literal parts from the default value
        // SHOULD be split because they're in an unquoted context
        return smartWordSplitWithUnquotedLiterals(
          ctx,
          opWordParts,
          ifsChars,
          _ifsPattern,
          expandPartFn
        );
      }
    }
  }

  // Expand all parts and track if they are splittable
  // Also track if they have mixed quoted default values that need special handling
  type Segment = {
    value: string;
    isSplittable: boolean;
    /** True if this is a quoted part (DoubleQuoted or SingleQuoted) - can anchor empty words */
    isQuoted: boolean;
    mixedDefaultParts?: WordPart[];
  };
  const segments: Segment[] = [];
  let hasAnySplittable = false;

  for (const part of wordParts) {
    const splittable = isPartSplittable(part);
    const isQuoted =
      part.type === "DoubleQuoted" || part.type === "SingleQuoted";
    // Check if this part has a mixed quoted/unquoted default value
    const mixedDefaultParts = splittable
      ? await hasMixedQuotedDefaultValue(ctx, part)
      : null;
    const expanded = await expandPartFn(ctx, part);
    segments.push({
      value: expanded,
      isSplittable: splittable,
      isQuoted,
      mixedDefaultParts: mixedDefaultParts ?? undefined
    });

    if (splittable) {
      hasAnySplittable = true;
    }
  }

  // If there's no splittable expansion, return the joined value as-is
  // (pure literals are not subject to IFS splitting)
  if (!hasAnySplittable) {
    const joined = segments.map((s) => s.value).join("");
    return joined ? [joined] : [];
  }

  // Now do the smart word splitting:
  // - Splittable parts get split by IFS
  // - Non-splittable parts (quoted, literals) join with adjacent fields
  //
  // Algorithm:
  // We maintain an array of words being built. The current word is built up
  // by accumulating non-split content. When we split a splittable part:
  // - The first fragment joins with the current word
  // - Middle fragments become separate words
  // - The last fragment becomes the start of a new current word
  //
  // Important distinction:
  // - split returning [] (empty array) = nothing to add, continue building
  // - split returning [""] (array with one empty string) = produces empty word
  // - split returning ["x"] = produces "x" to append to current word

  const words: string[] = [];
  let currentWord = "";
  // Track if we've produced any actual words (including empty ones from splits)
  let hasProducedWord = false;
  // Track if the previous splittable segment ended with a trailing IFS delimiter
  // If true, the next non-splittable content should start a new word
  let pendingWordBreak = false;
  // Track if the previous segment was a quoted empty string (can anchor empty words)
  let prevWasQuotedEmpty = false;

  for (const segment of segments) {
    if (!segment.isSplittable) {
      // Non-splittable: append to current word (no splitting)
      // BUT if we have a pending word break from a previous trailing delimiter,
      // push the current word first and start a new one.
      //
      // Special case: if this is a quoted empty segment and we have a pending word break,
      // we should produce an empty word (the quoted empty "anchors" an empty word).
      if (pendingWordBreak) {
        if (segment.isQuoted && segment.value === "") {
          // Quoted empty after trailing IFS delimiter: push current word and an empty word
          if (currentWord !== "") {
            words.push(currentWord);
          }
          // The quoted empty anchors an empty word
          words.push("");
          hasProducedWord = true;
          currentWord = "";
          pendingWordBreak = false;
          prevWasQuotedEmpty = true;
        } else if (segment.value !== "") {
          // Non-empty content: push current word (if any) and start new word
          if (currentWord !== "") {
            words.push(currentWord);
          }
          currentWord = segment.value;
          pendingWordBreak = false;
          prevWasQuotedEmpty = false;
        } else {
          // Empty non-quoted segment with pending break: just append (noop)
          currentWord += segment.value;
          prevWasQuotedEmpty = false;
        }
      } else {
        currentWord += segment.value;
        prevWasQuotedEmpty = segment.isQuoted && segment.value === "";
      }
    } else if (segment.mixedDefaultParts) {
      // Special case: ParameterExpansion with mixed quoted/unquoted default value
      // We need to recursively word-split the default value's parts to preserve
      // quote boundaries. This handles cases like: 1${undefined:-"2_3"x_x"4_5"}6
      // where the quoted parts "2_3" and "4_5" should NOT be split by IFS.
      const splitParts = await smartWordSplitWithUnquotedLiterals(
        ctx,
        segment.mixedDefaultParts,
        ifsChars,
        _ifsPattern,
        expandPartFn
      );

      if (splitParts.length === 0) {
        // Empty expansion produces nothing
      } else if (splitParts.length === 1) {
        currentWord += splitParts[0];
        hasProducedWord = true;
      } else {
        // Multiple results: first joins with current, middle are separate, last starts new
        currentWord += splitParts[0];
        words.push(currentWord);
        hasProducedWord = true;

        for (let i = 1; i < splitParts.length - 1; i++) {
          words.push(splitParts[i]);
        }

        currentWord = splitParts[splitParts.length - 1];
      }
      // Reset pending word break after processing mixed default parts
      pendingWordBreak = false;
      prevWasQuotedEmpty = false;
    } else {
      // Splittable: split by IFS using extended version that tracks trailing delimiters
      const {
        words: parts,
        hadLeadingDelimiter,
        hadTrailingDelimiter
      } = splitByIfsForExpansionEx(segment.value, ifsChars);

      // If the previous segment was a quoted empty and this splittable segment
      // has leading IFS delimiter, the quoted empty should anchor an empty word
      if (prevWasQuotedEmpty && hadLeadingDelimiter && currentWord === "") {
        words.push("");
        hasProducedWord = true;
      }

      if (parts.length === 0) {
        // Empty expansion produces nothing - continue building current word
        // This happens for empty string or all-whitespace with default IFS
        // BUT if there was a trailing delimiter (e.g., "   "), mark pending word break
        if (hadTrailingDelimiter) {
          pendingWordBreak = true;
        }
      } else if (parts.length === 1) {
        // Single result: just append to current word
        // Note: parts[0] might be empty string (e.g., IFS='_' and var='_' produces [""])
        currentWord += parts[0];
        hasProducedWord = true;
        // If there was a trailing delimiter, mark pending word break for next segment
        pendingWordBreak = hadTrailingDelimiter;
      } else {
        // Multiple results from split:
        // - First part joins with current word
        // - Middle parts become separate words
        // - Last part starts the new current word
        currentWord += parts[0];
        words.push(currentWord);
        hasProducedWord = true;

        // Add middle parts as separate words
        for (let i = 1; i < parts.length - 1; i++) {
          words.push(parts[i]);
        }

        // Last part becomes the new current word
        currentWord = parts[parts.length - 1];
        // If there was a trailing delimiter, mark pending word break for next segment
        pendingWordBreak = hadTrailingDelimiter;
      }
      prevWasQuotedEmpty = false;
    }
  }

  // Add the remaining current word
  // We add it if:
  // - currentWord is non-empty, OR
  // - we haven't produced any words yet but we've had a split that produced content
  //   (this handles the case of IFS='_' and var='_' -> [""])
  if (currentWord !== "") {
    words.push(currentWord);
  } else if (words.length === 0 && hasProducedWord) {
    // The only content was from a split that produced [""] (empty string)
    words.push("");
  }

  return words;
}

/**
 * Check if a string starts with an IFS character
 */
function startsWithIfs(value: string, ifsChars: string): boolean {
  return value.length > 0 && ifsChars.includes(value[0]);
}

/**
 * Word splitting for default value parts where Literal parts ARE splittable.
 * This is used when processing ${var:-"a b" c} where the default value has
 * mixed quoted and unquoted parts. The unquoted Literal parts should be split.
 */
async function smartWordSplitWithUnquotedLiterals(
  ctx: InterpreterContext,
  wordParts: WordPart[],
  ifsChars: string,
  _ifsPattern: string,
  expandPartFn: ExpandPartFn
): Promise<string[]> {
  // Expand all parts and track if they are splittable
  // In this context, Literal parts ARE splittable
  type Segment = { value: string; isSplittable: boolean };
  const segments: Segment[] = [];

  for (const part of wordParts) {
    // Quoted parts are not splittable
    const isQuoted =
      part.type === "DoubleQuoted" || part.type === "SingleQuoted";
    // In the context of a default value, everything non-quoted is splittable
    const splittable = !isQuoted;
    const expanded = await expandPartFn(ctx, part);
    segments.push({ value: expanded, isSplittable: splittable });
  }

  // Word splitting algorithm
  // Key difference from standard smartWordSplit:
  // When a splittable segment starts with an IFS character, it causes a word break
  // from the previous content, even if the split produces only one word.
  const words: string[] = [];
  let currentWord = "";
  let hasProducedWord = false;
  let pendingWordBreak = false;

  for (const segment of segments) {
    if (!segment.isSplittable) {
      // Non-splittable (quoted): append to current word
      // BUT if we have a pending word break, push current word first
      // However, don't push an empty current word - that happens when we have
      // whitespace between two quoted parts, which should just separate them
      // without creating an empty word in between
      if (pendingWordBreak && segment.value !== "") {
        if (currentWord !== "") {
          words.push(currentWord);
        }
        currentWord = segment.value;
        pendingWordBreak = false;
      } else {
        currentWord += segment.value;
      }
    } else {
      // Splittable: check if it starts with IFS (causes word break)
      const startsWithIfsChar = startsWithIfs(segment.value, ifsChars);

      // If the segment starts with IFS and we have accumulated content,
      // finish the current word first
      if (startsWithIfsChar && currentWord !== "") {
        words.push(currentWord);
        currentWord = "";
        hasProducedWord = true;
      }

      // Split by IFS using extended version
      const { words: parts, hadTrailingDelimiter } = splitByIfsForExpansionEx(
        segment.value,
        ifsChars
      );

      if (parts.length === 0) {
        // Empty expansion produces nothing
        if (hadTrailingDelimiter) {
          pendingWordBreak = true;
        }
      } else if (parts.length === 1) {
        currentWord += parts[0];
        hasProducedWord = true;
        pendingWordBreak = hadTrailingDelimiter;
      } else {
        // Multiple results from split
        currentWord += parts[0];
        words.push(currentWord);
        hasProducedWord = true;

        for (let i = 1; i < parts.length - 1; i++) {
          words.push(parts[i]);
        }

        currentWord = parts[parts.length - 1];
        pendingWordBreak = hadTrailingDelimiter;
      }
    }
  }

  if (currentWord !== "") {
    words.push(currentWord);
  } else if (words.length === 0 && hasProducedWord) {
    words.push("");
  }

  return words;
}
