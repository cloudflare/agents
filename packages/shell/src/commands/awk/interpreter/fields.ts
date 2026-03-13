/**
 * AWK Field Operations
 *
 * Handles $0, $1, $2, etc. field access and modification.
 */

import { ConstantRegex, createUserRegex } from "../../../regex/index";
import type { AwkRuntimeContext } from "./context";
import { toAwkString } from "./type-coercion";
import type { AwkValue } from "./types";

/**
 * Split a line into fields based on the field separator.
 */
function splitFields(ctx: AwkRuntimeContext, line: string): string[] {
  // Empty line always has 0 fields in AWK
  if (line === "") {
    return [];
  }
  if (ctx.FS === " ") {
    // Default FS: split on runs of whitespace, skip leading/trailing
    return line.trim().split(/\s+/).filter(Boolean);
  }
  return ctx.fieldSep.split(line);
}

/**
 * Get a field value by index.
 * $0 is the whole line, $1 is first field, etc.
 */
export function getField(ctx: AwkRuntimeContext, index: number): AwkValue {
  if (index === 0) {
    return ctx.line;
  }
  if (index < 0 || index > ctx.fields.length) {
    return "";
  }
  return ctx.fields[index - 1] ?? "";
}

/**
 * Set a field value by index.
 * Setting $0 re-splits the line. Setting other fields rebuilds $0.
 */
export function setField(
  ctx: AwkRuntimeContext,
  index: number,
  value: AwkValue
): void {
  if (index === 0) {
    // Setting $0 re-splits the line
    ctx.line = toAwkString(value);
    ctx.fields = splitFields(ctx, ctx.line);
    ctx.NF = ctx.fields.length;
  } else if (index > 0) {
    // Extend fields array if needed
    while (ctx.fields.length < index) {
      ctx.fields.push("");
    }
    ctx.fields[index - 1] = toAwkString(value);
    ctx.NF = ctx.fields.length;
    // Rebuild $0 from fields
    ctx.line = ctx.fields.join(ctx.OFS);
  }
}

/**
 * Update context with a new line (used when processing input).
 */
export function setCurrentLine(ctx: AwkRuntimeContext, line: string): void {
  ctx.line = line;
  ctx.fields = splitFields(ctx, line);
  ctx.NF = ctx.fields.length;
}

/**
 * Update field separator and recompile regex.
 */
export function setFieldSeparator(ctx: AwkRuntimeContext, fs: string): void {
  ctx.FS = fs;
  if (fs === " ") {
    ctx.fieldSep = new ConstantRegex(/\s+/);
  } else {
    try {
      ctx.fieldSep = createUserRegex(fs);
    } catch {
      ctx.fieldSep = createUserRegex(fs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
}
