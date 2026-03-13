/**
 * Tilde expansion helper functions.
 *
 * Handles ~ expansion in assignment contexts.
 */

import type { InterpreterContext } from "../types";

/**
 * Expand tildes in assignment values (PATH-like expansion)
 * - ~ at start expands to HOME
 * - ~ after : expands to HOME (for PATH-like values)
 * - ~username expands to user's home (only root supported)
 */
export function expandTildesInValue(
  ctx: InterpreterContext,
  value: string
): string {
  const home = ctx.state.env.get("HOME") || "/home/user";

  // Split by : to handle PATH-like values
  const parts = value.split(":");
  const expanded = parts.map((part) => {
    if (part === "~") {
      return home;
    }
    if (part === "~root") {
      return "/root";
    }
    if (part.startsWith("~/")) {
      return home + part.slice(1);
    }
    if (part.startsWith("~root/")) {
      return `/root${part.slice(5)}`;
    }
    // ~otheruser stays literal (can't verify user exists)
    return part;
  });

  return expanded.join(":");
}
