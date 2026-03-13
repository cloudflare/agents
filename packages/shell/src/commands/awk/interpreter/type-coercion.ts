/**
 * AWK Type Conversion Helpers
 *
 * Pure functions for type conversion and truthiness checking.
 */

import { createUserRegex } from "../../../regex/index";
import type { AwkValue } from "./types";

/**
 * Check if a value is truthy in AWK.
 * - Numbers: truthy if non-zero
 * - Empty string: falsy
 * - String "0": falsy (canonical string representation of zero)
 * - All other non-empty strings: truthy (including "00", "0.0", etc.)
 */
export function isTruthy(val: AwkValue): boolean {
  if (typeof val === "number") {
    return val !== 0;
  }
  // Empty string is always falsy
  if (val === "") {
    return false;
  }
  // Only the exact string "0" is falsy (canonical representation of zero)
  // Other numeric-looking strings like "00", "0.0" are truthy as strings
  if (val === "0") {
    return false;
  }
  // All other non-empty strings are truthy
  return true;
}

/**
 * Convert an AWK value to a number.
 * Strings are parsed as floats, empty/non-numeric strings become 0.
 */
export function toNumber(val: AwkValue): number {
  if (typeof val === "number") return val;
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Convert an AWK value to a string.
 * Numbers are formatted without trailing zeros.
 */
export function toAwkString(val: AwkValue): string {
  if (typeof val === "string") return val;
  if (Number.isInteger(val)) return String(val);
  return String(val);
}

/**
 * Check if a value looks like a number for comparison purposes.
 */
export function looksLikeNumber(val: AwkValue): boolean {
  if (typeof val === "number") return true;
  const s = String(val).trim();
  if (s === "") return false;
  return !Number.isNaN(Number(s));
}

/**
 * Test if a string matches a regex pattern.
 */
export function matchRegex(pattern: string, text: string): boolean {
  try {
    return createUserRegex(pattern).test(text);
  } catch {
    return false;
  }
}
