/**
 * xtrace (set -x) helper functions
 *
 * Handles trace output generation when xtrace option is enabled.
 * PS4 variable controls the prefix (default "+ ").
 * PS4 is expanded (variable substitution) before each trace line.
 */

import { Parser } from "../../parser/parser";
import { expandWord } from "../expansion";
import type { InterpreterContext } from "../types";

/**
 * Default PS4 value when not set
 */
const DEFAULT_PS4 = "+ ";

/**
 * Expand the PS4 variable and return the trace prefix.
 * PS4 is expanded with variable substitution.
 * If PS4 expansion fails, falls back to default "+ ".
 */
async function getXtracePrefix(ctx: InterpreterContext): Promise<string> {
  const ps4 = ctx.state.env.get("PS4");

  // If PS4 is not set, return default
  if (ps4 === undefined) {
    return DEFAULT_PS4;
  }

  // If PS4 is empty string (explicitly unset), bash uses no prefix
  // Actually, bash outputs nothing for trace lines when PS4 is empty
  if (ps4 === "") {
    return "";
  }

  try {
    // Parse PS4 as a word to handle variable expansion
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(ps4, false, false);

    // Expand the word (handles $VAR, ${VAR}, $?, $LINENO, etc.)
    const expanded = await expandWord(ctx, wordNode);

    return expanded;
  } catch {
    // If expansion fails, print error to stderr (like bash does) and return literal PS4
    // Bash continues execution but reports the error
    ctx.state.expansionStderr = `${ctx.state.expansionStderr || ""}bash: ${ps4}: bad substitution\n`;
    return ps4 || DEFAULT_PS4;
  }
}

/**
 * Format a trace line for output.
 * Quotes arguments that need quoting for shell safety.
 */
function formatTraceLine(parts: string[]): string {
  return parts.map((part) => quoteForTrace(part)).join(" ");
}

/**
 * Quote a value for trace output if needed.
 * Follows bash conventions for xtrace output quoting.
 */
function quoteForTrace(value: string): string {
  // Empty string needs quotes
  if (value === "") {
    return "''";
  }

  // Check if quoting is needed
  // Need to quote if contains: whitespace, quotes, special chars, newlines
  const needsQuoting = /[\s'"\\$`!*?[\]{}|&;<>()~#\n\t]/.test(value);

  if (!needsQuoting) {
    return value;
  }

  // Check for special characters that need $'...' quoting
  // oxlint-disable-next-line no-control-regex -- intentional control char detection
  const hasControlChars = /[\x00-\x1f\x7f]/.test(value);
  const hasNewline = value.includes("\n");
  const hasTab = value.includes("\t");
  const hasBackslash = value.includes("\\");
  const hasSingleQuote = value.includes("'");

  // Use $'...' quoting for control characters, newlines, tabs
  if (hasControlChars || hasNewline || hasTab || hasBackslash) {
    let escaped = "";
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (char === "\n") {
        escaped += "\\n";
      } else if (char === "\t") {
        escaped += "\\t";
      } else if (char === "\\") {
        escaped += "\\\\";
      } else if (char === "'") {
        escaped += "'";
      } else if (char === '"') {
        escaped += '"';
      } else if (code < 32 || code === 127) {
        // Control character - use \xNN or \uNNNN
        if (code < 256) {
          escaped += `\\x${code.toString(16).padStart(2, "0")}`;
        } else {
          escaped += `\\u${code.toString(16).padStart(4, "0")}`;
        }
      } else {
        escaped += char;
      }
    }
    return `$'${escaped}'`;
  }

  // Use single quotes if possible (no single quotes in value)
  if (!hasSingleQuote) {
    return `'${value}'`;
  }

  // Use double quotes for values with single quotes
  // Need to escape $ ` \ " in double quotes
  const escaped = value.replace(/([\\$`"])/g, "\\$1");
  return `"${escaped}"`;
}

/**
 * Generate xtrace output for a simple command.
 * Returns the trace line to be added to stderr.
 */
export async function traceSimpleCommand(
  ctx: InterpreterContext,
  commandName: string,
  args: string[]
): Promise<string> {
  if (!ctx.state.options.xtrace) {
    return "";
  }

  const prefix = await getXtracePrefix(ctx);
  const parts = [commandName, ...args];
  const traceLine = formatTraceLine(parts);

  return `${prefix}${traceLine}\n`;
}

/**
 * Generate xtrace output for an assignment.
 * Returns the trace line to be added to stderr.
 */
export async function traceAssignment(
  ctx: InterpreterContext,
  name: string,
  value: string
): Promise<string> {
  if (!ctx.state.options.xtrace) {
    return "";
  }

  const prefix = await getXtracePrefix(ctx);
  // Don't quote the assignment value - show raw name=value
  return `${prefix}${name}=${value}\n`;
}
