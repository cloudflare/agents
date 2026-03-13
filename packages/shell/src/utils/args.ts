/**
 * Lightweight argument parser for command implementations.
 *
 * Handles common patterns:
 * - Boolean flags: -n, --number
 * - Combined short flags: -rn (same as -r -n)
 * - Value options: -k VALUE, -kVALUE, --key=VALUE, --key VALUE
 * - Positional arguments
 * - Unknown option detection
 */

import { unknownOption } from "../commands/help";
import type { ExecResult } from "../types";

export type ArgType = "boolean" | "string" | "number";

export interface ArgDef {
  /** Short form without dash, e.g., "n" for -n */
  short?: string;
  /** Long form without dashes, e.g., "number" for --number */
  long?: string;
  /** Type of the argument */
  type: ArgType;
  /** Default value */
  default?: boolean | string | number;
}

export interface ParsedArgs<T extends Record<string, ArgDef>> {
  /** Parsed flag/option values */
  flags: {
    [K in keyof T]: T[K]["type"] extends "boolean"
      ? boolean
      : T[K]["default"] extends number | string
        ? T[K]["type"] extends "number"
          ? number
          : string
        : T[K]["type"] extends "number"
          ? number | undefined
          : string | undefined;
  };
  /** Positional arguments (non-flag arguments) */
  positional: string[];
}

export type ParseResult<T extends Record<string, ArgDef>> =
  | { ok: true; result: ParsedArgs<T> }
  | { ok: false; error: ExecResult };

/**
 * Parse command arguments according to the provided definitions.
 *
 * @param cmdName - Command name for error messages
 * @param args - Arguments to parse
 * @param defs - Argument definitions
 * @returns Parsed arguments or error result
 *
 * @example
 * const defs = {
 *   reverse: { short: "r", long: "reverse", type: "boolean" as const },
 *   count: { short: "n", long: "lines", type: "number" as const, default: 10 },
 * };
 * const result = parseArgs("head", args, defs);
 * if (!result.ok) return result.error;
 * const { flags, positional } = result.result;
 */
export function parseArgs<T extends Record<string, ArgDef>>(
  cmdName: string,
  args: string[],
  defs: T
): ParseResult<T> {
  // Build lookup maps: map short/long options to {name, type}
  const shortToInfo = new Map<string, { name: string; type: ArgType }>();
  const longToInfo = new Map<string, { name: string; type: ArgType }>();

  for (const [name, def] of Object.entries(defs)) {
    const info = { name, type: def.type };
    if (def.short) shortToInfo.set(def.short, info);
    if (def.long) longToInfo.set(def.long, info);
  }

  // Initialize with defaults
  // Boolean flags default to false, but string/number flags without
  // explicit defaults remain undefined (allowing callers to detect if set)
  // Use null-prototype to prevent prototype pollution
  const flags: Record<string, boolean | string | number | undefined> =
    Object.create(null);
  for (const [name, def] of Object.entries(defs)) {
    if (def.default !== undefined) {
      flags[name] = def.default;
    } else if (def.type === "boolean") {
      flags[name] = false;
    }
    // String and number types without defaults remain undefined
  }

  const positional: string[] = [];
  let stopParsing = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (stopParsing || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }

    if (arg === "--") {
      stopParsing = true;
      continue;
    }

    if (arg.startsWith("--")) {
      // Long option
      const eqIndex = arg.indexOf("=");
      let optName: string;
      let optValue: string | undefined;

      if (eqIndex !== -1) {
        optName = arg.slice(2, eqIndex);
        optValue = arg.slice(eqIndex + 1);
      } else {
        optName = arg.slice(2);
      }

      const info = longToInfo.get(optName);
      if (!info) {
        return { ok: false, error: unknownOption(cmdName, arg) };
      }

      const { name, type } = info;
      if (type === "boolean") {
        flags[name] = true;
      } else {
        // Need a value
        if (optValue === undefined) {
          if (i + 1 >= args.length) {
            return {
              ok: false,
              error: {
                stdout: "",
                stderr: `${cmdName}: option '--${optName}' requires an argument\n`,
                exitCode: 1
              }
            };
          }
          optValue = args[++i];
        }
        flags[name] = type === "number" ? parseInt(optValue, 10) : optValue;
      }
    } else {
      // Short option(s)
      const chars = arg.slice(1);

      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        const info = shortToInfo.get(c);

        if (!info) {
          return { ok: false, error: unknownOption(cmdName, `-${c}`) };
        }

        const { name, type } = info;
        if (type === "boolean") {
          flags[name] = true;
        } else {
          // Value option - rest of string or next arg
          let optValue: string;
          if (j + 1 < chars.length) {
            // Value is attached: -n10
            optValue = chars.slice(j + 1);
          } else if (i + 1 < args.length) {
            // Value is next arg: -n 10
            optValue = args[++i];
          } else {
            return {
              ok: false,
              error: {
                stdout: "",
                stderr: `${cmdName}: option requires an argument -- '${c}'\n`,
                exitCode: 1
              }
            };
          }
          flags[name] = type === "number" ? parseInt(optValue, 10) : optValue;
          break; // Rest of chars consumed as value
        }
      }
    }
  }

  return {
    ok: true,
    result: {
      flags: flags as ParsedArgs<T>["flags"],
      positional
    }
  };
}
