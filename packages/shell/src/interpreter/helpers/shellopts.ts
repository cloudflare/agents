/**
 * SHELLOPTS and BASHOPTS variable helpers.
 *
 * SHELLOPTS is a colon-separated list of enabled shell options from `set -o`.
 * BASHOPTS is a colon-separated list of enabled bash-specific options from `shopt`.
 */

import type { InterpreterContext, ShellOptions, ShoptOptions } from "../types";

/**
 * List of shell option names in the order they appear in SHELLOPTS.
 * This matches bash's ordering (alphabetical).
 */
const SHELLOPTS_OPTIONS: (keyof ShellOptions)[] = [
  "allexport",
  "errexit",
  "noglob",
  "noclobber",
  "noexec",
  "nounset",
  "pipefail",
  "posix",
  "verbose",
  "xtrace"
];

/**
 * Options that are always enabled in bash (no-op in our implementation but
 * should appear in SHELLOPTS for compatibility).
 * These are in alphabetical order.
 */
const ALWAYS_ON_OPTIONS = ["braceexpand", "hashall", "interactive-comments"];

/**
 * Build the SHELLOPTS string from current shell options.
 * Returns a colon-separated list of enabled options (alphabetically sorted).
 * Includes always-on options like braceexpand, hashall, interactive-comments.
 */
export function buildShellopts(options: ShellOptions): string {
  const enabled: string[] = [];
  // Add always-on options and dynamic options in alphabetical order
  const allOptions = [
    ...ALWAYS_ON_OPTIONS.map((opt) => ({ name: opt, enabled: true })),
    ...SHELLOPTS_OPTIONS.map((opt) => ({ name: opt, enabled: options[opt] }))
  ].sort((a, b) => a.name.localeCompare(b.name));

  for (const opt of allOptions) {
    if (opt.enabled) {
      enabled.push(opt.name);
    }
  }
  return enabled.join(":");
}

/**
 * Update the SHELLOPTS environment variable to reflect current shell options.
 * Should be called whenever shell options change (via set -o or shopt -o).
 */
export function updateShellopts(ctx: InterpreterContext): void {
  ctx.state.env.set("SHELLOPTS", buildShellopts(ctx.state.options));
}

/**
 * List of shopt option names in the order they appear in BASHOPTS.
 * This matches bash's ordering (alphabetical).
 */
const BASHOPTS_OPTIONS: (keyof ShoptOptions)[] = [
  "dotglob",
  "expand_aliases",
  "extglob",
  "failglob",
  "globskipdots",
  "globstar",
  "lastpipe",
  "nocaseglob",
  "nocasematch",
  "nullglob",
  "xpg_echo"
];

/**
 * Build the BASHOPTS string from current shopt options.
 * Returns a colon-separated list of enabled options (alphabetically sorted).
 */
export function buildBashopts(shoptOptions: ShoptOptions): string {
  const enabled: string[] = [];
  for (const opt of BASHOPTS_OPTIONS) {
    if (shoptOptions[opt]) {
      enabled.push(opt);
    }
  }
  return enabled.join(":");
}

/**
 * Update the BASHOPTS environment variable to reflect current shopt options.
 * Should be called whenever shopt options change.
 */
export function updateBashopts(ctx: InterpreterContext): void {
  ctx.state.env.set("BASHOPTS", buildBashopts(ctx.state.shoptOptions));
}
