/**
 * Declare Print Mode Functions
 *
 * Handles printing and listing variables for the declare/typeset builtin.
 */

import type { ExecResult } from "../../types";
import { getArrayIndices, getAssocArrayKeys } from "../helpers/array";
import { isNameref } from "../helpers/nameref";
import {
  quoteArrayValue,
  quoteDeclareValue,
  quoteValue
} from "../helpers/quoting";
import { result, success } from "../helpers/result";
import type { InterpreterContext } from "../types";

/**
 * Get the attribute flags string for a variable (e.g., "-r", "-x", "-rx", "--")
 * Order follows bash convention: a/A (array), i (integer), l (lowercase), n (nameref), r (readonly), u (uppercase), x (export)
 */
function getVariableFlags(ctx: InterpreterContext, name: string): string {
  let flags = "";

  // Note: array flags (-a/-A) are handled separately in the caller
  // since they require different output format

  // Integer attribute
  if (ctx.state.integerVars?.has(name)) {
    flags += "i";
  }

  // Lowercase attribute
  if (ctx.state.lowercaseVars?.has(name)) {
    flags += "l";
  }

  // Nameref attribute
  if (isNameref(ctx, name)) {
    flags += "n";
  }

  // Readonly attribute
  if (ctx.state.readonlyVars?.has(name)) {
    flags += "r";
  }

  // Uppercase attribute
  if (ctx.state.uppercaseVars?.has(name)) {
    flags += "u";
  }

  // Export attribute
  if (ctx.state.exportedVars?.has(name)) {
    flags += "x";
  }

  return flags === "" ? "--" : `-${flags}`;
}

/**
 * Format a value for associative array output in declare -p.
 * Uses the oils/ysh-compatible format:
 * - Simple values (no spaces, no special chars): unquoted
 * - Empty strings or values with spaces/special chars: single-quoted with escaping
 */
function formatAssocValue(value: string): string {
  // Empty string needs quotes
  if (value === "") {
    return "''";
  }
  // If value contains spaces, single quotes, or other special chars, quote it
  if (/[\s'\\]/.test(value)) {
    // Escape single quotes as '\'' (end quote, escaped quote, start quote)
    const escaped = value.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
  // Simple value - no quotes needed
  return value;
}

/**
 * Print specific variables with their declarations.
 * Handles: declare -p varname1 varname2 ...
 */
export function printSpecificVariables(
  ctx: InterpreterContext,
  names: string[]
): ExecResult {
  let stdout = "";
  let stderr = "";
  let anyNotFound = false;

  for (const name of names) {
    // Get the variable's attribute flags (for scalar variables)
    const flags = getVariableFlags(ctx, name);

    // Check if this is an associative array
    const isAssoc = ctx.state.associativeArrays?.has(name);
    if (isAssoc) {
      const keys = getAssocArrayKeys(ctx, name);
      if (keys.length === 0) {
        stdout += `declare -A ${name}=()\n`;
      } else {
        const elements = keys.map((key) => {
          const value = ctx.state.env.get(`${name}_${key}`) ?? "";
          // Format: ['key']=value (single quotes around key)
          const formattedValue = formatAssocValue(value);
          return `['${key}']=${formattedValue}`;
        });
        stdout += `declare -A ${name}=(${elements.join(" ")})\n`;
      }
      continue;
    }

    // Check if this is an indexed array (has array elements)
    const arrayIndices = getArrayIndices(ctx, name);
    if (arrayIndices.length > 0) {
      const elements = arrayIndices.map((index) => {
        const value = ctx.state.env.get(`${name}_${index}`) ?? "";
        return `[${index}]=${quoteArrayValue(value)}`;
      });
      stdout += `declare -a ${name}=(${elements.join(" ")})\n`;
      continue;
    }

    // Check if this is an empty array (has __length marker but no elements)
    if (ctx.state.env.has(`${name}__length`)) {
      stdout += `declare -a ${name}=()\n`;
      continue;
    }

    // Regular scalar variable
    const value = ctx.state.env.get(name);
    if (value !== undefined) {
      // Use $'...' quoting for control characters, double quotes otherwise
      stdout += `declare ${flags} ${name}=${quoteDeclareValue(value)}\n`;
    } else {
      // Check if variable is declared but unset (via declare or local)
      const isDeclared = ctx.state.declaredVars?.has(name);
      const isLocalVar = ctx.state.localVarDepth?.has(name);
      if (isDeclared || isLocalVar) {
        // Variable is declared but has no value - output without =""
        stdout += `declare ${flags} ${name}\n`;
      } else {
        // Variable not found - add error to stderr and set flag for exit code 1
        stderr += `bash: declare: ${name}: not found\n`;
        anyNotFound = true;
      }
    }
  }

  return result(stdout, stderr, anyNotFound ? 1 : 0);
}

export interface PrintAllFilters {
  filterExport: boolean;
  filterReadonly: boolean;
  filterNameref: boolean;
  filterIndexedArray: boolean;
  filterAssocArray: boolean;
}

/**
 * Print all variables with their declarations and attributes.
 * Handles: declare -p (with optional filters like -x, -r, -n, -a, -A)
 */
export function printAllVariables(
  ctx: InterpreterContext,
  filters: PrintAllFilters
): ExecResult {
  const {
    filterExport,
    filterReadonly,
    filterNameref,
    filterIndexedArray,
    filterAssocArray
  } = filters;
  const hasFilter =
    filterExport ||
    filterReadonly ||
    filterNameref ||
    filterIndexedArray ||
    filterAssocArray;

  let stdout = "";

  // Collect all variable names (excluding internal markers like __length)
  const varNames = new Set<string>();
  for (const key of ctx.state.env.keys()) {
    if (key.startsWith("BASH_")) continue;
    // For __length markers, extract the base name (for empty arrays)
    if (key.endsWith("__length")) {
      const baseName = key.slice(0, -8);
      varNames.add(baseName);
      continue;
    }
    // For array elements (name_index), extract base name
    const underscoreIdx = key.lastIndexOf("_");
    if (underscoreIdx > 0) {
      const baseName = key.slice(0, underscoreIdx);
      const suffix = key.slice(underscoreIdx + 1);
      // If suffix is numeric or baseName is an array, it's an array element
      if (/^\d+$/.test(suffix) || ctx.state.associativeArrays?.has(baseName)) {
        varNames.add(baseName);
        continue;
      }
    }
    varNames.add(key);
  }

  // Also include local variables if we're in a function scope
  if (ctx.state.localVarDepth) {
    for (const name of ctx.state.localVarDepth.keys()) {
      varNames.add(name);
    }
  }

  // Include associative array names (for empty associative arrays)
  if (ctx.state.associativeArrays) {
    for (const name of ctx.state.associativeArrays) {
      varNames.add(name);
    }
  }

  // Sort and output each variable
  const sortedNames = Array.from(varNames).sort();
  for (const name of sortedNames) {
    const flags = getVariableFlags(ctx, name);

    // Check if this is an associative array
    const isAssoc = ctx.state.associativeArrays?.has(name);

    // Check if this is an indexed array (not associative)
    const arrayIndices = getArrayIndices(ctx, name);
    const isIndexedArray =
      !isAssoc &&
      (arrayIndices.length > 0 || ctx.state.env.has(`${name}__length`));

    // Apply filters if set
    if (hasFilter) {
      // If filtering for associative arrays only (-pA)
      if (filterAssocArray && !isAssoc) continue;
      // If filtering for indexed arrays only (-pa)
      if (filterIndexedArray && !isIndexedArray) continue;
      // If filtering for exported only (-px)
      if (filterExport && !ctx.state.exportedVars?.has(name)) continue;
      // If filtering for readonly only (-pr)
      if (filterReadonly && !ctx.state.readonlyVars?.has(name)) continue;
      // If filtering for nameref only (-pn)
      if (filterNameref && !isNameref(ctx, name)) continue;
    }

    if (isAssoc) {
      const keys = getAssocArrayKeys(ctx, name);
      if (keys.length === 0) {
        stdout += `declare -A ${name}=()\n`;
      } else {
        const elements = keys.map((key) => {
          const value = ctx.state.env.get(`${name}_${key}`) ?? "";
          // Format: ['key']=value (single quotes around key)
          const formattedValue = formatAssocValue(value);
          return `['${key}']=${formattedValue}`;
        });
        stdout += `declare -A ${name}=(${elements.join(" ")})\n`;
      }
      continue;
    }

    // Check if this is an indexed array
    if (arrayIndices.length > 0) {
      const elements = arrayIndices.map((index) => {
        const value = ctx.state.env.get(`${name}_${index}`) ?? "";
        return `[${index}]=${quoteArrayValue(value)}`;
      });
      stdout += `declare -a ${name}=(${elements.join(" ")})\n`;
      continue;
    }

    // Check if this is an empty array
    if (ctx.state.env.has(`${name}__length`)) {
      stdout += `declare -a ${name}=()\n`;
      continue;
    }

    // Regular scalar variable
    const value = ctx.state.env.get(name);
    if (value !== undefined) {
      stdout += `declare ${flags} ${name}=${quoteDeclareValue(value)}\n`;
    }
  }

  return success(stdout);
}

/**
 * List all associative arrays.
 * Handles: declare -A (without arguments)
 */
export function listAssociativeArrays(ctx: InterpreterContext): ExecResult {
  let stdout = "";

  // Get all associative array names and sort them
  const assocNames = Array.from(ctx.state.associativeArrays ?? []).sort();

  for (const name of assocNames) {
    const keys = getAssocArrayKeys(ctx, name);
    if (keys.length === 0) {
      // Empty associative array
      stdout += `declare -A ${name}=()\n`;
    } else {
      // Non-empty associative array: format as (['key']=value ...)
      const elements = keys.map((key) => {
        const value = ctx.state.env.get(`${name}_${key}`) ?? "";
        // Format: ['key']=value (single quotes around key)
        const formattedValue = formatAssocValue(value);
        return `['${key}']=${formattedValue}`;
      });
      stdout += `declare -A ${name}=(${elements.join(" ")})\n`;
    }
  }

  return success(stdout);
}

/**
 * List all indexed arrays.
 * Handles: declare -a (without arguments)
 */
export function listIndexedArrays(ctx: InterpreterContext): ExecResult {
  let stdout = "";

  // Find all indexed arrays
  const arrayNames = new Set<string>();
  for (const key of ctx.state.env.keys()) {
    if (key.startsWith("BASH_")) continue;
    // Check for __length marker (empty arrays)
    if (key.endsWith("__length")) {
      const baseName = key.slice(0, -8);
      // Make sure it's not an associative array
      if (!ctx.state.associativeArrays?.has(baseName)) {
        arrayNames.add(baseName);
      }
      continue;
    }
    // Check for numeric index pattern (name_index)
    const lastUnderscore = key.lastIndexOf("_");
    if (lastUnderscore > 0) {
      const baseName = key.slice(0, lastUnderscore);
      const suffix = key.slice(lastUnderscore + 1);
      // If suffix is numeric, it's an array element
      if (/^\d+$/.test(suffix)) {
        // Make sure it's not an associative array
        if (!ctx.state.associativeArrays?.has(baseName)) {
          arrayNames.add(baseName);
        }
      }
    }
  }

  // Output each array in sorted order
  const sortedNames = Array.from(arrayNames).sort();
  for (const name of sortedNames) {
    const indices = getArrayIndices(ctx, name);
    if (indices.length === 0) {
      // Empty array
      stdout += `declare -a ${name}=()\n`;
    } else {
      // Non-empty array: format as ([index]="value" ...)
      const elements = indices.map((index) => {
        const value = ctx.state.env.get(`${name}_${index}`) ?? "";
        return `[${index}]=${quoteArrayValue(value)}`;
      });
      stdout += `declare -a ${name}=(${elements.join(" ")})\n`;
    }
  }

  return success(stdout);
}

/**
 * List all variables without print mode (no attributes shown).
 * Handles: declare (without -p and without arguments)
 */
export function listAllVariables(ctx: InterpreterContext): ExecResult {
  let stdout = "";

  // Collect all variable names (excluding internal markers)
  const varNames = new Set<string>();
  for (const key of ctx.state.env.keys()) {
    if (key.startsWith("BASH_")) continue;
    // For __length markers, extract the base name (for arrays)
    if (key.endsWith("__length")) {
      const baseName = key.slice(0, -8);
      varNames.add(baseName);
      continue;
    }
    // For array elements (name_index), extract base name
    const underscoreIdx = key.lastIndexOf("_");
    if (underscoreIdx > 0) {
      const baseName = key.slice(0, underscoreIdx);
      const suffix = key.slice(underscoreIdx + 1);
      // If suffix is numeric or baseName is an associative array
      if (/^\d+$/.test(suffix) || ctx.state.associativeArrays?.has(baseName)) {
        varNames.add(baseName);
        continue;
      }
    }
    varNames.add(key);
  }

  const sortedNames = Array.from(varNames).sort();
  for (const name of sortedNames) {
    // Check if this is an associative array
    const isAssoc = ctx.state.associativeArrays?.has(name);
    if (isAssoc) {
      // Skip associative arrays for simple declare output
      continue;
    }

    // Check if this is an indexed array
    const arrayIndices = getArrayIndices(ctx, name);
    if (arrayIndices.length > 0 || ctx.state.env.has(`${name}__length`)) {
      // Skip indexed arrays for simple declare output
      continue;
    }

    // Regular scalar variable - output as name=value
    const value = ctx.state.env.get(name);
    if (value !== undefined) {
      stdout += `${name}=${quoteValue(value)}\n`;
    }
  }

  return success(stdout);
}
