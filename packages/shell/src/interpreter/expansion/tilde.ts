/**
 * Tilde Expansion
 *
 * Functions for handling tilde (~) expansion in word expansion.
 */

import type { InterpreterContext } from "../types";

/**
 * Apply tilde expansion to a string.
 * Used after brace expansion to handle cases like ~{/src,root} -> ~/src ~root -> /home/user/src /root
 * Only expands ~ at the start of the string followed by / or end of string.
 */
export function applyTildeExpansion(
  ctx: InterpreterContext,
  value: string
): string {
  if (!value.startsWith("~")) {
    return value;
  }

  // Use HOME if set (even if empty), otherwise fall back to /home/user
  const home =
    ctx.state.env.get("HOME") !== undefined
      ? ctx.state.env.get("HOME")
      : "/home/user";

  // ~/ or just ~
  if (value === "~" || value.startsWith("~/")) {
    return home + value.slice(1);
  }

  // ~username case: find where the username ends
  // Username chars are alphanumeric, underscore, and hyphen
  let i = 1;
  while (i < value.length && /[a-zA-Z0-9_-]/.test(value[i])) {
    i++;
  }
  const username = value.slice(1, i);
  const rest = value.slice(i);

  // Only expand if followed by / or end of string
  if (rest !== "" && !rest.startsWith("/")) {
    return value;
  }

  // Only support ~root expansion in sandboxed environment
  if (username === "root") {
    return `/root${rest}`;
  }

  // Unknown user - keep literal
  return value;
}
