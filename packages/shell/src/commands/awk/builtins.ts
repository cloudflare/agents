/**
 * AWK Built-in Functions
 *
 * Implementation of AWK built-in functions for the AST-based interpreter.
 */

import { createUserRegex, type UserRegex } from "../../regex/index";
import type { AwkExpr } from "./ast";
import type { AwkRuntimeContext } from "./interpreter/context";
import type { AwkValue } from "./interpreter/types";

/**
 * Interface for evaluating expressions (passed from interpreter)
 */
export interface AwkEvaluator {
  evalExpr: (expr: AwkExpr) => Promise<AwkValue>;
}

export type AwkBuiltinFn = (
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
) => AwkValue | Promise<AwkValue>;

// Helper functions for type conversion
function toNumber(val: AwkValue): number {
  if (typeof val === "number") return val;
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}

function toAwkString(val: AwkValue): string {
  if (typeof val === "string") return val;
  if (Number.isInteger(val)) return String(val);
  return String(val);
}

/**
 * Extract a regex pattern from an AWK expression argument.
 * Handles both regex literals and string expressions.
 */
async function extractPatternArg(
  arg: AwkExpr,
  evaluator: AwkEvaluator
): Promise<string> {
  if (arg.type === "regex") {
    return arg.pattern;
  }
  let pattern = toAwkString(await evaluator.evalExpr(arg));
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    pattern = pattern.slice(1, -1);
  }
  return pattern;
}

/**
 * Resolve a target variable name from a sub/gsub third argument.
 * Returns the variable name (e.g., "myvar", "$0", "$1").
 */
async function resolveTargetName(
  targetExpr: AwkExpr | undefined,
  evaluator: AwkEvaluator
): Promise<string> {
  if (!targetExpr) return "$0";
  if (targetExpr.type === "variable") {
    return targetExpr.name;
  }
  if (targetExpr.type === "field") {
    const idx = Math.floor(
      toNumber(await evaluator.evalExpr(targetExpr.index))
    );
    return `$${idx}`;
  }
  return "$0";
}

/**
 * Get the current value of a target variable.
 */
function getTargetValue(targetName: string, ctx: AwkRuntimeContext): string {
  if (targetName === "$0") {
    return ctx.line;
  }
  if (targetName.startsWith("$")) {
    const idx = parseInt(targetName.slice(1), 10) - 1;
    return ctx.fields[idx] || "";
  }
  return toAwkString(ctx.vars[targetName] ?? "");
}

/**
 * Apply a new value to a target variable, updating $0 and fields as needed.
 */
function applyTargetValue(
  targetName: string,
  newValue: string,
  ctx: AwkRuntimeContext
): void {
  if (targetName === "$0") {
    ctx.line = newValue;
    ctx.fields =
      ctx.FS === " "
        ? newValue.trim().split(/\s+/).filter(Boolean)
        : ctx.fieldSep.split(newValue);
    ctx.NF = ctx.fields.length;
  } else if (targetName.startsWith("$")) {
    const idx = parseInt(targetName.slice(1), 10) - 1;
    while (ctx.fields.length <= idx) ctx.fields.push("");
    ctx.fields[idx] = newValue;
    ctx.NF = ctx.fields.length;
    ctx.line = ctx.fields.join(ctx.OFS);
  } else {
    ctx.vars[targetName] = newValue;
  }
}

// ─── String Functions ───────────────────────────────────────────

async function awkLength(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) {
    return ctx.line.length;
  }
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  return str.length;
}

async function awkSubstr(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<string> {
  if (args.length < 2) return "";
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const start = Math.floor(toNumber(await evaluator.evalExpr(args[1]))) - 1;

  if (args.length >= 3) {
    const len = Math.floor(toNumber(await evaluator.evalExpr(args[2])));
    return str.substr(Math.max(0, start), len);
  }
  return str.substr(Math.max(0, start));
}

async function awkIndex(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length < 2) return 0;
  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const target = toAwkString(await evaluator.evalExpr(args[1]));
  const idx = str.indexOf(target);
  return idx === -1 ? 0 : idx + 1;
}

async function awkSplit(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length < 2) return 0;
  const str = toAwkString(await evaluator.evalExpr(args[0]));

  const arrayExpr = args[1];
  if (arrayExpr.type !== "variable") {
    return 0;
  }
  const arrayName = arrayExpr.name;

  let sep: string | UserRegex = ctx.FS;
  if (args.length >= 3) {
    const sepExpr = args[2];
    // Check if the separator is a regex literal
    if (sepExpr.type === "regex") {
      sep = createUserRegex(sepExpr.pattern);
    } else {
      const sepVal = toAwkString(await evaluator.evalExpr(sepExpr));
      sep = sepVal === " " ? createUserRegex("\\s+") : sepVal;
    }
  } else if (ctx.FS === " ") {
    sep = createUserRegex("\\s+");
  }

  const parts = typeof sep === "string" ? str.split(sep) : sep.split(str);

  // Use null-prototype to prevent prototype pollution with user-controlled keys
  ctx.arrays[arrayName] = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    ctx.arrays[arrayName][String(i + 1)] = parts[i];
  }

  return parts.length;
}

async function awkSub(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length < 2) return 0;

  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]));
  const targetName = await resolveTargetName(args[2], evaluator);
  const target = getTargetValue(targetName, ctx);

  try {
    const regex = createUserRegex(pattern);
    const newTarget = regex.replace(target, createSubReplacer(replacement));
    const changed = newTarget !== target ? 1 : 0;
    applyTargetValue(targetName, newTarget, ctx);
    return changed;
  } catch {
    return 0;
  }
}

async function awkGsub(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length < 2) return 0;

  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]));
  const targetName = await resolveTargetName(args[2], evaluator);
  const target = getTargetValue(targetName, ctx);

  try {
    const regex = createUserRegex(pattern, "g");
    const matches = regex.match(target);
    const count = matches ? matches.length : 0;
    const newTarget = regex.replace(target, createSubReplacer(replacement));
    applyTargetValue(targetName, newTarget, ctx);
    return count;
  } catch {
    return 0;
  }
}

function createSubReplacer(replacement: string): (match: string) => string {
  return (match: string) => {
    let result = "";
    let i = 0;
    while (i < replacement.length) {
      if (replacement[i] === "\\" && i + 1 < replacement.length) {
        const next = replacement[i + 1];
        if (next === "&") {
          result += "&";
          i += 2;
        } else if (next === "\\") {
          result += "\\";
          i += 2;
        } else {
          result += replacement[i + 1];
          i += 2;
        }
      } else if (replacement[i] === "&") {
        result += match;
        i++;
      } else {
        result += replacement[i];
        i++;
      }
    }
    return result;
  };
}

async function awkMatch(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length < 2) {
    ctx.RSTART = 0;
    ctx.RLENGTH = -1;
    return 0;
  }

  const str = toAwkString(await evaluator.evalExpr(args[0]));
  const pattern = await extractPatternArg(args[1], evaluator);

  try {
    const regex = createUserRegex(pattern);
    const match = regex.exec(str);
    if (match) {
      ctx.RSTART = match.index + 1;
      ctx.RLENGTH = match[0].length;
      return ctx.RSTART;
    }
  } catch {
    // Invalid regex
  }

  ctx.RSTART = 0;
  ctx.RLENGTH = -1;
  return 0;
}

async function awkGensub(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<string> {
  if (args.length < 3) return "";

  const pattern = await extractPatternArg(args[0], evaluator);
  const replacement = toAwkString(await evaluator.evalExpr(args[1]));
  const how = toAwkString(await evaluator.evalExpr(args[2]));
  const target =
    args.length >= 4
      ? toAwkString(await evaluator.evalExpr(args[3]))
      : ctx.line;

  try {
    const isGlobal = how.toLowerCase() === "g";
    const occurrenceNum = isGlobal ? 0 : parseInt(how, 10) || 1;

    if (isGlobal) {
      const regex = createUserRegex(pattern, "g");
      return regex.replace(target, (match, ...groups) =>
        processGensub(
          replacement,
          match as string,
          groups.slice(0, -2) as string[]
        )
      );
    } else {
      let count = 0;
      const regex = createUserRegex(pattern, "g");
      return regex.replace(target, (match, ...groups) => {
        count++;
        if (count === occurrenceNum) {
          return processGensub(
            replacement,
            match as string,
            groups.slice(0, -2) as string[]
          );
        }
        return match as string;
      });
    }
  } catch {
    return target;
  }
}

function processGensub(
  replacement: string,
  match: string,
  groups: string[]
): string {
  let result = "";
  let i = 0;
  while (i < replacement.length) {
    if (replacement[i] === "\\" && i + 1 < replacement.length) {
      const next = replacement[i + 1];
      if (next === "&") {
        result += "&";
        i += 2;
      } else if (next === "0") {
        result += match;
        i += 2;
      } else if (next >= "1" && next <= "9") {
        const idx = parseInt(next, 10) - 1;
        result += groups[idx] || "";
        i += 2;
      } else if (next === "n") {
        result += "\n";
        i += 2;
      } else if (next === "t") {
        result += "\t";
        i += 2;
      } else {
        result += next;
        i += 2;
      }
    } else if (replacement[i] === "&") {
      result += match;
      i++;
    } else {
      result += replacement[i];
      i++;
    }
  }
  return result;
}

async function awkTolower(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<string> {
  if (args.length === 0) return "";
  return toAwkString(await evaluator.evalExpr(args[0])).toLowerCase();
}

async function awkToupper(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<string> {
  if (args.length === 0) return "";
  return toAwkString(await evaluator.evalExpr(args[0])).toUpperCase();
}

async function awkSprintf(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<string> {
  if (args.length === 0) return "";
  const format = toAwkString(await evaluator.evalExpr(args[0]));
  const values: AwkValue[] = [];
  for (let i = 1; i < args.length; i++) {
    values.push(await evaluator.evalExpr(args[i]));
  }
  return formatPrintf(format, values);
}

// ─── Math Functions ─────────────────────────────────────────────

async function awkInt(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.floor(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkSqrt(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.sqrt(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkSin(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.sin(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkCos(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.cos(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkAtan2(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  const y = args.length > 0 ? toNumber(await evaluator.evalExpr(args[0])) : 0;
  const x = args.length > 1 ? toNumber(await evaluator.evalExpr(args[1])) : 0;
  return Math.atan2(y, x);
}

async function awkLog(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) return 0;
  return Math.log(toNumber(await evaluator.evalExpr(args[0])));
}

async function awkExp(
  args: AwkExpr[],
  _ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  if (args.length === 0) return 1;
  return Math.exp(toNumber(await evaluator.evalExpr(args[0])));
}

function awkRand(
  _args: AwkExpr[],
  ctx: AwkRuntimeContext,
  _evaluator: AwkEvaluator
): number {
  return ctx.random ? ctx.random() : Math.random();
}

async function awkSrand(
  args: AwkExpr[],
  ctx: AwkRuntimeContext,
  evaluator: AwkEvaluator
): Promise<number> {
  const seed =
    args.length > 0 ? toNumber(await evaluator.evalExpr(args[0])) : Date.now();
  ctx.vars._srand_seed = seed;
  return seed;
}

// ─── Unsupported Functions ──────────────────────────────────────

function unsupported(name: string, reason: string): AwkBuiltinFn {
  return () => {
    throw new Error(`${name}() is not supported - ${reason}`);
  };
}

function unimplemented(name: string): AwkBuiltinFn {
  return () => {
    throw new Error(`function '${name}()' is not implemented`);
  };
}

// ─── Printf Formatting ──────────────────────────────────────────

const MAX_PRINTF_WIDTH = 10000;

export function formatPrintf(format: string, values: AwkValue[]): string {
  let valueIdx = 0;
  let result = "";
  let i = 0;

  while (i < format.length) {
    if (format[i] === "%" && i + 1 < format.length) {
      let j = i + 1;
      let flags = "";
      let width = "";
      let precision = "";
      let positionalIdx: number | undefined;

      // Check for positional argument: %n$ where n is a number
      const posStart = j;
      while (j < format.length && /\d/.test(format[j])) {
        j++;
      }
      if (j > posStart && format[j] === "$") {
        // Found positional argument like %2$
        positionalIdx = parseInt(format.substring(posStart, j), 10) - 1; // Convert to 0-based
        j++; // Skip the $
      } else {
        // Not positional, reset j
        j = posStart;
      }

      // Skip length modifiers (l, ll, z, j, h, hh) - they're ignored in AWK but shouldn't break parsing
      const skipLengthMods = () => {
        if (j < format.length) {
          // Check for hh or ll first (2-char modifiers)
          if (
            j + 1 < format.length &&
            ((format[j] === "h" && format[j + 1] === "h") ||
              (format[j] === "l" && format[j + 1] === "l"))
          ) {
            j += 2;
            return;
          }
          // Check for single-char modifiers
          if (/[lzjh]/.test(format[j])) {
            j++;
          }
        }
      };

      while (j < format.length && /[-+ #0]/.test(format[j])) {
        flags += format[j++];
      }

      // Handle * for width
      if (format[j] === "*") {
        const widthVal = values[valueIdx++];
        const w = widthVal !== undefined ? Math.floor(Number(widthVal)) : 0;
        if (w < 0) {
          flags += "-";
          width = String(Math.min(-w, MAX_PRINTF_WIDTH));
        } else {
          width = String(Math.min(w, MAX_PRINTF_WIDTH));
        }
        j++;
      } else {
        while (j < format.length && /\d/.test(format[j])) {
          width += format[j++];
        }
      }
      // Cap width to prevent memory bombs
      if (width && parseInt(width, 10) > MAX_PRINTF_WIDTH) {
        width = String(MAX_PRINTF_WIDTH);
      }

      if (format[j] === ".") {
        j++;
        // Handle * for precision
        if (format[j] === "*") {
          const precVal = values[valueIdx++];
          precision = String(
            Math.min(
              precVal !== undefined ? Math.floor(Number(precVal)) : 0,
              MAX_PRINTF_WIDTH
            )
          );
          j++;
        } else {
          while (j < format.length && /\d/.test(format[j])) {
            precision += format[j++];
          }
        }
        // Cap precision to prevent memory bombs
        if (precision && parseInt(precision, 10) > MAX_PRINTF_WIDTH) {
          precision = String(MAX_PRINTF_WIDTH);
        }
      }

      // Skip length modifiers before the specifier
      skipLengthMods();

      const spec = format[j];
      // Use positional index if specified, otherwise use sequential index
      const valIdx = positionalIdx !== undefined ? positionalIdx : valueIdx;
      const val = values[valIdx];

      switch (spec) {
        case "s": {
          let str = val !== undefined ? String(val) : "";
          if (precision) {
            str = str.substring(0, parseInt(precision, 10));
          }
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "d":
        case "i": {
          let num = val !== undefined ? Math.floor(Number(val)) : 0;
          if (Number.isNaN(num)) num = 0;
          const isNegative = num < 0;
          let digits = Math.abs(num).toString();

          // Precision for integers means minimum number of digits (zero-padded)
          if (precision) {
            const prec = parseInt(precision, 10);
            digits = digits.padStart(prec, "0");
          }

          // Add sign
          let sign = "";
          if (isNegative) {
            sign = "-";
          } else if (flags.includes("+")) {
            sign = "+";
          } else if (flags.includes(" ")) {
            sign = " ";
          }

          let str = sign + digits;

          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else if (flags.includes("0") && !precision) {
              // Zero-padding only applies when no precision is specified
              str = sign + digits.padStart(w - sign.length, "0");
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "f": {
          let num = val !== undefined ? Number(val) : 0;
          if (Number.isNaN(num)) num = 0;
          const prec = precision ? parseInt(precision, 10) : 6;
          let str = num.toFixed(prec);
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "e":
        case "E": {
          let num = val !== undefined ? Number(val) : 0;
          if (Number.isNaN(num)) num = 0;
          const prec = precision ? parseInt(precision, 10) : 6;
          let str = num.toExponential(prec);
          if (spec === "E") str = str.toUpperCase();
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "g":
        case "G": {
          let num = val !== undefined ? Number(val) : 0;
          if (Number.isNaN(num)) num = 0;
          const prec = precision ? parseInt(precision, 10) : 6;
          const exp = num !== 0 ? Math.floor(Math.log10(Math.abs(num))) : 0;
          let str: string;
          if (num === 0) {
            str = "0";
          } else if (exp < -4 || exp >= prec) {
            str = num.toExponential(prec - 1);
            if (spec === "G") str = str.toUpperCase();
          } else {
            str = num.toPrecision(prec);
          }
          // Remove trailing zeros after decimal point, but keep at least one digit
          // Must not match standalone "0" (which has no decimal point)
          if (str.includes(".")) {
            str = str.replace(/\.?0+$/, "").replace(/\.?0+e/, "e");
          }
          if (str.includes("e")) {
            str = str.replace(/\.?0+e/, "e");
          }
          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "x":
        case "X": {
          let num = val !== undefined ? Math.floor(Number(val)) : 0;
          if (Number.isNaN(num)) num = 0;
          let digits = Math.abs(num).toString(16);
          if (spec === "X") digits = digits.toUpperCase();

          // Precision for hex means minimum number of digits (zero-padded)
          if (precision) {
            const prec = parseInt(precision, 10);
            digits = digits.padStart(prec, "0");
          }

          const sign = num < 0 ? "-" : "";
          let str = sign + digits;

          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else if (flags.includes("0") && !precision) {
              str = sign + digits.padStart(w - sign.length, "0");
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "o": {
          let num = val !== undefined ? Math.floor(Number(val)) : 0;
          if (Number.isNaN(num)) num = 0;
          let digits = Math.abs(num).toString(8);

          // Precision for octal means minimum number of digits (zero-padded)
          if (precision) {
            const prec = parseInt(precision, 10);
            digits = digits.padStart(prec, "0");
          }

          const sign = num < 0 ? "-" : "";
          let str = sign + digits;

          if (width) {
            const w = parseInt(width, 10);
            if (flags.includes("-")) {
              str = str.padEnd(w);
            } else if (flags.includes("0") && !precision) {
              str = sign + digits.padStart(w - sign.length, "0");
            } else {
              str = str.padStart(w);
            }
          }
          result += str;
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "c": {
          if (typeof val === "number") {
            result += String.fromCharCode(val);
          } else {
            result += String(val ?? "").charAt(0) || "";
          }
          if (positionalIdx === undefined) valueIdx++;
          break;
        }

        case "%":
          result += "%";
          break;

        default:
          result += format.substring(i, j + 1);
      }
      i = j + 1;
    } else if (format[i] === "\\" && i + 1 < format.length) {
      const esc = format[i + 1];
      switch (esc) {
        case "n":
          result += "\n";
          break;
        case "t":
          result += "\t";
          break;
        case "r":
          result += "\r";
          break;
        case "\\":
          result += "\\";
          break;
        default:
          result += esc;
      }
      i += 2;
    } else {
      result += format[i++];
    }
  }

  return result;
}

// ─── Built-in Function Registry ─────────────────────────────────

export const awkBuiltins: Map<string, AwkBuiltinFn> = new Map([
  // String functions
  ["length", awkLength],
  ["substr", awkSubstr],
  ["index", awkIndex],
  ["split", awkSplit],
  ["sub", awkSub],
  ["gsub", awkGsub],
  ["match", awkMatch],
  ["gensub", awkGensub],
  ["tolower", awkTolower],
  ["toupper", awkToupper],
  ["sprintf", awkSprintf],

  // Math functions
  ["int", awkInt],
  ["sqrt", awkSqrt],
  ["sin", awkSin],
  ["cos", awkCos],
  ["atan2", awkAtan2],
  ["log", awkLog],
  ["exp", awkExp],
  ["rand", awkRand],
  ["srand", awkSrand],

  // Unsupported functions (security/sandboxing)
  [
    "system",
    unsupported(
      "system",
      "shell execution not allowed in sandboxed environment"
    )
  ],
  // close() and fflush() are no-ops in our environment (no real file handles)
  // Return 0 for success to allow programs that use them to work
  ["close", () => 0],
  ["fflush", () => 0],

  // Unimplemented functions
  ["systime", unimplemented("systime")],
  ["mktime", unimplemented("mktime")],
  ["strftime", unimplemented("strftime")]
]);
