/**
 * Interpreter Utility Functions
 *
 * Standalone helper functions used by the interpreter.
 */

import type { WordNode } from "../../ast/types";

/**
 * Check if a WordNode is a literal match for any of the given strings.
 * Returns true only if the word is a single literal (no expansions, no quoting)
 * that matches one of the target strings.
 *
 * This is used to detect assignment builtins at "parse time" - bash determines
 * whether a command is export/declare/etc based on the literal token, not the
 * runtime value after expansion.
 */
export function isWordLiteralMatch(word: WordNode, targets: string[]): boolean {
  // Must be a single part
  if (word.parts.length !== 1) {
    return false;
  }
  const part = word.parts[0];
  // Must be a simple literal (not quoted, not an expansion)
  if (part.type !== "Literal") {
    return false;
  }
  return targets.includes(part.value);
}

/**
 * Parse the content of a read-write file descriptor.
 * Format: __rw__:pathLength:path:position:content
 * @returns The parsed components, or null if format is invalid
 */
export function parseRwFdContent(fdContent: string): {
  path: string;
  position: number;
  content: string;
} | null {
  if (!fdContent.startsWith("__rw__:")) {
    return null;
  }
  // Parse pathLength
  const afterPrefix = fdContent.slice(7); // After "__rw__:"
  const firstColonIdx = afterPrefix.indexOf(":");
  if (firstColonIdx === -1) {
    return null;
  }
  const pathLength = Number.parseInt(afterPrefix.slice(0, firstColonIdx), 10);
  if (Number.isNaN(pathLength) || pathLength < 0) {
    return null;
  }
  // Extract path using length
  const pathStart = firstColonIdx + 1;
  const path = afterPrefix.slice(pathStart, pathStart + pathLength);
  // Parse position (after path and colon)
  const positionStart = pathStart + pathLength + 1; // +1 for ":"
  const remaining = afterPrefix.slice(positionStart);
  const posColonIdx = remaining.indexOf(":");
  if (posColonIdx === -1) {
    return null;
  }
  const position = Number.parseInt(remaining.slice(0, posColonIdx), 10);
  if (Number.isNaN(position) || position < 0) {
    return null;
  }
  // Extract content (after position and colon)
  const content = remaining.slice(posColonIdx + 1);
  return { path, position, content };
}
