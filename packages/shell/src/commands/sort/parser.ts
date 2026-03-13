// Parser for sort key specifications

import type { KeySpec } from "./types";

/**
 * Parse a key specification like:
 * - "1" - field 1
 * - "1,2" - fields 1 through 2
 * - "1.3" - field 1 starting at char 3
 * - "1.3,2.5" - field 1 char 3 through field 2 char 5
 * - "1n" - field 1, numeric
 * - "1,2nr" - fields 1-2, numeric and reverse
 */
export function parseKeySpec(spec: string): KeySpec | null {
  // Pattern: FIELD[.CHAR][,FIELD[.CHAR]][MODIFIERS]
  // Where MODIFIERS can be: n (numeric), r (reverse), f (fold case), b (ignore blanks)

  const result: KeySpec = {
    startField: 1
  };

  // Check for modifiers at the end
  let modifierStr = "";
  let mainSpec = spec;

  // Find where modifiers start (after all digits, dots, and commas)
  // Valid modifiers: b d f h M n r V
  const modifierMatch = mainSpec.match(/([bdfhMnrV]+)$/);
  if (modifierMatch) {
    modifierStr = modifierMatch[1];
    mainSpec = mainSpec.slice(0, -modifierStr.length);
  }

  // Parse modifiers (case-sensitive: M and V are uppercase)
  if (modifierStr.includes("n")) result.numeric = true;
  if (modifierStr.includes("r")) result.reverse = true;
  if (modifierStr.includes("f")) result.ignoreCase = true;
  if (modifierStr.includes("b")) result.ignoreLeading = true;
  if (modifierStr.includes("h")) result.humanNumeric = true;
  if (modifierStr.includes("V")) result.versionSort = true;
  if (modifierStr.includes("d")) result.dictionaryOrder = true;
  if (modifierStr.includes("M")) result.monthSort = true;

  // Split by comma for start and end
  const parts = mainSpec.split(",");

  if (parts.length === 0 || parts[0] === "") {
    return null;
  }

  // Parse start position
  const startParts = parts[0].split(".");
  const startField = parseInt(startParts[0], 10);
  if (Number.isNaN(startField) || startField < 1) {
    return null;
  }
  result.startField = startField;

  if (startParts.length > 1 && startParts[1]) {
    const startChar = parseInt(startParts[1], 10);
    if (!Number.isNaN(startChar) && startChar >= 1) {
      result.startChar = startChar;
    }
  }

  // Parse end position if present
  if (parts.length > 1 && parts[1]) {
    // End part might have trailing modifiers too
    let endPart = parts[1];
    const endModifierMatch = endPart.match(/([bdfhMnrV]+)$/);
    if (endModifierMatch) {
      const endModifiers = endModifierMatch[1];
      if (endModifiers.includes("n")) result.numeric = true;
      if (endModifiers.includes("r")) result.reverse = true;
      if (endModifiers.includes("f")) result.ignoreCase = true;
      if (endModifiers.includes("b")) result.ignoreLeading = true;
      if (endModifiers.includes("h")) result.humanNumeric = true;
      if (endModifiers.includes("V")) result.versionSort = true;
      if (endModifiers.includes("d")) result.dictionaryOrder = true;
      if (endModifiers.includes("M")) result.monthSort = true;
      endPart = endPart.slice(0, -endModifiers.length);
    }

    const endParts = endPart.split(".");
    if (endParts[0]) {
      const endField = parseInt(endParts[0], 10);
      if (!Number.isNaN(endField) && endField >= 1) {
        result.endField = endField;
      }

      if (endParts.length > 1 && endParts[1]) {
        const endChar = parseInt(endParts[1], 10);
        if (!Number.isNaN(endChar) && endChar >= 1) {
          result.endChar = endChar;
        }
      }
    }
  }

  return result;
}
