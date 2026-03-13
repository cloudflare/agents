/**
 * Pattern Removal Helpers
 *
 * Functions for ${var#pattern}, ${var%pattern}, ${!prefix*} etc.
 */

import { createUserRegex } from "../../regex/index";
import type { InterpreterContext } from "../types";

/**
 * Apply pattern removal (prefix or suffix strip) to a single value.
 * Used by both scalar and vectorized array operations.
 */
export function applyPatternRemoval(
  value: string,
  regexStr: string,
  side: "prefix" | "suffix",
  greedy: boolean
): string {
  // Use 's' flag (dotall) so that . matches newlines (bash ? matches any char including newline)
  if (side === "prefix") {
    // Prefix removal: greedy matches longest from start, non-greedy matches shortest
    return createUserRegex(`^${regexStr}`, "s").replace(value, "");
  }
  // Suffix removal needs special handling because we need to find
  // the rightmost (shortest) or leftmost (longest) match
  const regex = createUserRegex(`${regexStr}$`, "s");
  if (greedy) {
    // %% - longest match: use regex directly (finds leftmost match)
    return regex.replace(value, "");
  }
  // % - shortest match: find rightmost position where pattern matches to end
  for (let i = value.length; i >= 0; i--) {
    const suffix = value.slice(i);
    if (regex.test(suffix)) {
      return value.slice(0, i);
    }
  }
  return value;
}

/**
 * Get variable names that match a given prefix.
 * Used for ${!prefix*} and ${!prefix@} expansions.
 * Handles arrays properly - includes array base names from __length markers,
 * excludes internal storage keys like arr_0, arr__length.
 */
export function getVarNamesWithPrefix(
  ctx: InterpreterContext,
  prefix: string
): string[] {
  const envKeys = Array.from(ctx.state.env.keys());
  const matchingVars = new Set<string>();

  // Get sets of array names for filtering
  const assocArrays = ctx.state.associativeArrays ?? new Set<string>();
  const indexedArrays = new Set<string>();
  // Find indexed arrays by looking for _\d+$ patterns
  for (const k of envKeys) {
    const match = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_\d+$/);
    if (match) {
      indexedArrays.add(match[1]);
    }
    const lengthMatch = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)__length$/);
    if (lengthMatch) {
      indexedArrays.add(lengthMatch[1]);
    }
  }

  // Helper to check if a key is an associative array element
  const isAssocArrayElement = (key: string): boolean => {
    for (const arrayName of assocArrays) {
      const elemPrefix = `${arrayName}_`;
      if (key.startsWith(elemPrefix) && key !== arrayName) {
        return true;
      }
    }
    return false;
  };

  for (const k of envKeys) {
    if (k.startsWith(prefix)) {
      // Check if this is an internal array storage key
      if (k.includes("__")) {
        // For __length markers, add the base array name
        const lengthMatch = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)__length$/);
        if (lengthMatch?.[1].startsWith(prefix)) {
          matchingVars.add(lengthMatch[1]);
        }
        // Skip other internal markers
      } else if (/_\d+$/.test(k)) {
        // Skip indexed array element storage (arr_0)
        // But add the base array name if it matches
        const match = k.match(/^([a-zA-Z_][a-zA-Z0-9_]*)_\d+$/);
        if (match?.[1].startsWith(prefix)) {
          matchingVars.add(match[1]);
        }
      } else if (isAssocArrayElement(k)) {
        // Skip associative array elements
      } else {
        // Regular variable
        matchingVars.add(k);
      }
    }
  }

  return [...matchingVars].sort();
}
