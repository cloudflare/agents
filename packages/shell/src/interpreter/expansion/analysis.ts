/**
 * Word Analysis
 *
 * Functions for analyzing word parts to determine what types of expansions are present.
 */

import type { ParameterExpansionPart, WordPart } from "../../ast/types";

/**
 * Check if a glob pattern string contains variable references ($var or ${var})
 * This is used to detect when IFS splitting should apply to expanded glob patterns.
 */
export function globPatternHasVarRef(pattern: string): boolean {
  // Look for $varname or ${...} patterns
  // Skip escaped $ (e.g., \$)
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++; // Skip next character
      continue;
    }
    if (pattern[i] === "$") {
      const next = pattern[i + 1];
      // Check for ${...} or $varname
      if (next === "{" || (next && /[a-zA-Z_]/.test(next))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a parameter expansion has quoted parts in its operation word
 * e.g., ${v:-"AxBxC"} has a quoted default value
 */
function hasQuotedOperationWord(part: ParameterExpansionPart): boolean {
  if (!part.operation) return false;

  const op = part.operation;
  let wordParts: WordPart[] | undefined;

  // These operation types have a 'word' property that can contain quoted parts
  if (
    op.type === "DefaultValue" ||
    op.type === "AssignDefault" ||
    op.type === "UseAlternative" ||
    op.type === "ErrorIfUnset"
  ) {
    wordParts = op.word?.parts;
  }

  if (!wordParts) return false;

  for (const p of wordParts) {
    if (p.type === "DoubleQuoted" || p.type === "SingleQuoted") {
      return true;
    }
  }
  return false;
}

/**
 * Check if a parameter expansion's operation word is entirely quoted (all parts are quoted).
 * This is different from hasQuotedOperationWord which returns true if ANY part is quoted.
 *
 * For word splitting purposes:
 * - ${v:-"AxBxC"} - entirely quoted, should NOT be split
 * - ${v:-x"AxBxC"x} - mixed quoted/unquoted, SHOULD be split (on unquoted parts)
 * - ${v:-AxBxC} - entirely unquoted, SHOULD be split
 */
export function isOperationWordEntirelyQuoted(
  part: ParameterExpansionPart
): boolean {
  if (!part.operation) return false;

  const op = part.operation;
  let wordParts: WordPart[] | undefined;

  // These operation types have a 'word' property that can contain quoted parts
  if (
    op.type === "DefaultValue" ||
    op.type === "AssignDefault" ||
    op.type === "UseAlternative" ||
    op.type === "ErrorIfUnset"
  ) {
    wordParts = op.word?.parts;
  }

  if (!wordParts || wordParts.length === 0) return false;

  // Check if ALL parts are quoted (DoubleQuoted or SingleQuoted)
  for (const p of wordParts) {
    if (p.type !== "DoubleQuoted" && p.type !== "SingleQuoted") {
      return false; // Found an unquoted part
    }
  }
  return true; // All parts are quoted
}

/**
 * Result of analyzing word parts
 */
export interface WordPartsAnalysis {
  hasQuoted: boolean;
  hasCommandSub: boolean;
  hasArrayVar: boolean;
  hasArrayAtExpansion: boolean;
  hasParamExpansion: boolean;
  hasVarNamePrefixExpansion: boolean;
  hasIndirection: boolean;
}

/**
 * Analyze word parts for expansion behavior
 */
export function analyzeWordParts(parts: WordPart[]): WordPartsAnalysis {
  let hasQuoted = false;
  let hasCommandSub = false;
  let hasArrayVar = false;
  let hasArrayAtExpansion = false;
  let hasParamExpansion = false;
  let hasVarNamePrefixExpansion = false;
  let hasIndirection = false;

  for (const part of parts) {
    if (part.type === "SingleQuoted" || part.type === "DoubleQuoted") {
      hasQuoted = true;
      // Check for "${a[@]}" inside double quotes
      // BUT NOT if there's an operation like ${#a[@]} (Length) or other operations
      if (part.type === "DoubleQuoted") {
        for (const inner of part.parts) {
          if (inner.type === "ParameterExpansion") {
            // Check if it's array[@] or array[*]
            const match = inner.parameter.match(
              /^([a-zA-Z_][a-zA-Z0-9_]*)\[[@*]\]$/
            );
            // Set hasArrayAtExpansion for:
            // - No operation: ${arr[@]}
            // - PatternRemoval: ${arr[@]#pattern}, ${arr[@]%pattern}
            // - PatternReplacement: ${arr[@]/pattern/replacement}
            if (
              match &&
              (!inner.operation ||
                inner.operation.type === "PatternRemoval" ||
                inner.operation.type === "PatternReplacement")
            ) {
              hasArrayAtExpansion = true;
            }
            // Check for ${!prefix@} or ${!prefix*} inside double quotes
            if (
              inner.operation?.type === "VarNamePrefix" ||
              inner.operation?.type === "ArrayKeys"
            ) {
              hasVarNamePrefixExpansion = true;
            }
            // Check for ${!var} indirect expansion inside double quotes
            if (inner.operation?.type === "Indirection") {
              hasIndirection = true;
            }
          }
        }
      }
    }
    if (part.type === "CommandSubstitution") {
      hasCommandSub = true;
    }
    if (part.type === "ParameterExpansion") {
      hasParamExpansion = true;
      if (part.parameter === "@" || part.parameter === "*") {
        hasArrayVar = true;
      }
      // Check if the parameter expansion has quoted parts in its operation
      // e.g., ${v:-"AxBxC"} - the quoted default value should prevent word splitting
      if (hasQuotedOperationWord(part)) {
        hasQuoted = true;
      }
      // Check for unquoted ${!prefix@} or ${!prefix*}
      if (
        part.operation?.type === "VarNamePrefix" ||
        part.operation?.type === "ArrayKeys"
      ) {
        hasVarNamePrefixExpansion = true;
      }
      // Check for ${!var} indirect expansion
      if (part.operation?.type === "Indirection") {
        hasIndirection = true;
      }
    }
    // Check Glob parts for variable references - patterns like +($ABC) contain
    // parameter expansions that should be subject to IFS splitting
    if (part.type === "Glob" && globPatternHasVarRef(part.pattern)) {
      hasParamExpansion = true;
    }
  }

  return {
    hasQuoted,
    hasCommandSub,
    hasArrayVar,
    hasArrayAtExpansion,
    hasParamExpansion,
    hasVarNamePrefixExpansion,
    hasIndirection
  };
}
