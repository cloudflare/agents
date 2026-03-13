/**
 * Assignment Expansion Helpers
 *
 * Handles expansion of assignment arguments for local/declare/typeset builtins.
 * - Array assignments: name=(elem1 elem2 ...)
 * - Scalar assignments: name=value, name+=value, name[index]=value
 */

import type { WordNode } from "../ast/types";
import { expandWord, expandWordWithGlob } from "./expansion";
import { wordToLiteralString } from "./helpers/array";
import type { InterpreterContext } from "./types";

/**
 * Check if a Word represents an array assignment (name=(...)) and expand it
 * while preserving quote structure for elements.
 * Returns the expanded string like "name=(elem1 elem2 ...)" or null if not an array assignment.
 */
export async function expandLocalArrayAssignment(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string | null> {
  // First, join all parts to check if this looks like an array assignment
  const fullLiteral = word.parts
    .map((p) => (p.type === "Literal" ? p.value : "\x00"))
    .join("");
  const arrayMatch = fullLiteral.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\(/);
  if (!arrayMatch || !fullLiteral.endsWith(")")) {
    return null;
  }

  const name = arrayMatch[1];
  const elements: string[] = [];
  let inArrayContent = false;
  let pendingLiteral = "";
  // Track whether we've seen a quoted part (SingleQuoted, DoubleQuoted) since
  // last element push. This ensures empty quoted strings like '' are preserved.
  let hasQuotedContent = false;

  for (const part of word.parts) {
    if (part.type === "Literal") {
      let value = part.value;
      if (!inArrayContent) {
        // Look for =( to start array content
        const idx = value.indexOf("=(");
        if (idx !== -1) {
          inArrayContent = true;
          value = value.slice(idx + 2);
        }
      }

      if (inArrayContent) {
        // Check for closing )
        if (value.endsWith(")")) {
          value = value.slice(0, -1);
        }

        // Process literal content: split by whitespace
        // But handle the case where this literal is adjacent to a quoted part
        const tokens = value.split(/(\s+)/);
        for (const token of tokens) {
          if (/^\s+$/.test(token)) {
            // Whitespace - push pending element if we have content OR saw quoted part
            if (pendingLiteral || hasQuotedContent) {
              elements.push(pendingLiteral);
              pendingLiteral = "";
              hasQuotedContent = false;
            }
          } else if (token) {
            // Non-empty token - accumulate
            pendingLiteral += token;
          }
        }
      }
    } else if (inArrayContent) {
      // Handle BraceExpansion specially - it produces multiple values
      // BUT only if we're not inside a keyed element [key]=value
      if (part.type === "BraceExpansion") {
        // Check if pendingLiteral looks like a keyed element pattern: [key]=...
        // If so, brace expansion should NOT happen in the value part
        const isKeyedElement = /^\[.+\]=/.test(pendingLiteral);
        if (isKeyedElement) {
          // Inside a keyed element value - convert brace to literal, no expansion
          pendingLiteral += wordToLiteralString({
            type: "Word",
            parts: [part]
          });
        } else {
          // Plain element - expand braces normally
          // Push any pending literal first
          if (pendingLiteral || hasQuotedContent) {
            elements.push(pendingLiteral);
            pendingLiteral = "";
            hasQuotedContent = false;
          }
          // Use expandWordWithGlob to properly expand brace expressions
          const braceExpanded = await expandWordWithGlob(ctx, {
            type: "Word",
            parts: [part]
          });
          // Add each expanded value as a separate element
          elements.push(...braceExpanded.values);
        }
      } else {
        // Quoted/expansion part - expand it and accumulate as single element
        // Mark that we've seen quoted content (for empty string preservation)
        if (
          part.type === "SingleQuoted" ||
          part.type === "DoubleQuoted" ||
          part.type === "Escaped"
        ) {
          hasQuotedContent = true;
        }
        const expanded = await expandWord(ctx, {
          type: "Word",
          parts: [part]
        });
        pendingLiteral += expanded;
      }
    }
  }

  // Push final element if we have content OR saw quoted part
  if (pendingLiteral || hasQuotedContent) {
    elements.push(pendingLiteral);
  }

  // Build result string with proper quoting
  const quotedElements = elements.map((elem) => {
    // Don't quote keyed elements like ['key']=value or [index]=value
    // These need to be parsed by the declare builtin as-is
    if (/^\[.+\]=/.test(elem)) {
      return elem;
    }
    // Empty strings must be quoted to be preserved
    if (elem === "") {
      return "''";
    }
    // If element contains whitespace or special chars, quote it
    if (
      /[\s"'\\$`!*?[\]{}|&;<>()]/.test(elem) &&
      !elem.startsWith("'") &&
      !elem.startsWith('"')
    ) {
      // Use single quotes, escaping existing single quotes
      return `'${elem.replace(/'/g, "'\\''")}'`;
    }
    return elem;
  });

  return `${name}=(${quotedElements.join(" ")})`;
}

/**
 * Check if a Word represents a scalar assignment (name=value, name+=value, or name[index]=value)
 * and expand it WITHOUT glob expansion on the value part.
 * Returns the expanded string like "name=expanded_value" or null if not a scalar assignment.
 *
 * This is important for bash compatibility: `local var=$x` where x='a b' should
 * set var to "a b", not try to glob-expand it.
 */
export async function expandScalarAssignmentArg(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string | null> {
  // Look for = in the word parts to detect assignment pattern
  // We need to find where the assignment operator is and split there
  let eqPartIndex = -1;
  let eqCharIndex = -1;
  let isAppend = false;

  for (let i = 0; i < word.parts.length; i++) {
    const part = word.parts[i];
    if (part.type === "Literal") {
      // Check for += first
      const appendIdx = part.value.indexOf("+=");
      if (appendIdx !== -1) {
        // Verify it looks like an assignment: should have valid var name before +=
        const before = part.value.slice(0, appendIdx);
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(before)) {
          eqPartIndex = i;
          eqCharIndex = appendIdx;
          isAppend = true;
          break;
        }
        // Also check for array index append: name[index]+=
        if (/^[a-zA-Z_][a-zA-Z0-9_]*\[[^\]]+\]$/.test(before)) {
          eqPartIndex = i;
          eqCharIndex = appendIdx;
          isAppend = true;
          break;
        }
      }
      // Check for regular = (but not == or != or other operators)
      const eqIdx = part.value.indexOf("=");
      if (eqIdx !== -1 && (eqIdx === 0 || part.value[eqIdx - 1] !== "+")) {
        // Make sure it's not inside brackets like [0]= which we handle separately
        // and verify it looks like an assignment
        const before = part.value.slice(0, eqIdx);
        if (
          /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(before) ||
          /^[a-zA-Z_][a-zA-Z0-9_]*\[[^\]]+\]$/.test(before)
        ) {
          eqPartIndex = i;
          eqCharIndex = eqIdx;
          break;
        }
      }
    }
  }

  // No assignment operator found
  if (eqPartIndex === -1) {
    return null;
  }

  // Split the word into name part and value part
  const nameParts = word.parts.slice(0, eqPartIndex);
  const eqPart = word.parts[eqPartIndex];

  if (eqPart.type !== "Literal") {
    return null;
  }

  const operatorLen = isAppend ? 2 : 1;
  const nameFromEqPart = eqPart.value.slice(0, eqCharIndex);
  const valueFromEqPart = eqPart.value.slice(eqCharIndex + operatorLen);
  const valueParts = word.parts.slice(eqPartIndex + 1);

  // Construct the name by expanding the name parts (no glob needed for names)
  let name = "";
  for (const part of nameParts) {
    name += await expandWord(ctx, { type: "Word", parts: [part] });
  }
  name += nameFromEqPart;

  // Construct the value part Word for expansion WITHOUT glob
  const valueWord: WordNode = {
    type: "Word",
    parts:
      valueFromEqPart !== ""
        ? [{ type: "Literal", value: valueFromEqPart }, ...valueParts]
        : valueParts
  };

  // Expand the value WITHOUT glob expansion
  const value =
    valueWord.parts.length > 0 ? await expandWord(ctx, valueWord) : "";

  const operator = isAppend ? "+=" : "=";
  return `${name}${operator}${value}`;
}
