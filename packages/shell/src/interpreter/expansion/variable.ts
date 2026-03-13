/**
 * Variable Access
 *
 * Handles variable value retrieval, including:
 * - Special variables ($?, $$, $#, $@, $*, $0)
 * - Array access (${arr[0]}, ${arr[@]}, ${arr[*]})
 * - Positional parameters ($1, $2, ...)
 * - Regular variables
 * - Nameref resolution
 */

import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import { BASH_VERSION } from "../../shell-metadata";
import { evaluateArithmetic } from "../arithmetic";
import { BadSubstitutionError, NounsetError } from "../errors";
import {
  getArrayIndices,
  getAssocArrayKeys,
  unquoteKey
} from "../helpers/array";
import { getIfsSeparator } from "../helpers/ifs";
import { isNameref, resolveNameref } from "../helpers/nameref";
import type { InterpreterContext } from "../types";

/**
 * Expand simple variable references in a subscript string.
 * This handles patterns like $var and ${var} but not complex expansions.
 * Used to support namerefs pointing to array elements like A[$key].
 */
function expandSimpleVarsInSubscript(
  ctx: InterpreterContext,
  subscript: string
): string {
  // Replace ${varname} patterns
  let result = subscript.replace(
    /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (_, name) => ctx.state.env.get(name) ?? ""
  );
  // Replace $varname patterns (must be careful not to match ${})
  result = result.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (_, name) => ctx.state.env.get(name) ?? ""
  );
  return result;
}

/**
 * Get all elements of an array stored as arrayName_0, arrayName_1, etc.
 * Returns an array of [index/key, value] tuples, sorted by index/key.
 * For associative arrays, uses string keys.
 * Special arrays FUNCNAME, BASH_LINENO, and BASH_SOURCE are handled dynamically from call stack.
 */
export function getArrayElements(
  ctx: InterpreterContext,
  arrayName: string
): Array<[number | string, string]> {
  // Handle special call stack arrays
  if (arrayName === "FUNCNAME") {
    const stack = ctx.state.funcNameStack ?? [];
    return stack.map((name, i) => [i, name]);
  }
  if (arrayName === "BASH_LINENO") {
    const stack = ctx.state.callLineStack ?? [];
    return stack.map((line, i) => [i, String(line)]);
  }
  if (arrayName === "BASH_SOURCE") {
    const stack = ctx.state.sourceStack ?? [];
    return stack.map((source, i) => [i, source]);
  }

  const isAssoc = ctx.state.associativeArrays?.has(arrayName);

  if (isAssoc) {
    // For associative arrays, get string keys
    const keys = getAssocArrayKeys(ctx, arrayName);
    return keys.map((key) => [
      key,
      ctx.state.env.get(`${arrayName}_${key}`) ?? ""
    ]);
  }

  // For indexed arrays, get numeric indices
  const indices = getArrayIndices(ctx, arrayName);
  return indices.map((index) => [
    index,
    ctx.state.env.get(`${arrayName}_${index}`) ?? ""
  ]);
}

/**
 * Check if a variable is an array (has elements stored as name_0, name_1, etc.)
 */
export function isArray(ctx: InterpreterContext, name: string): boolean {
  // Handle special call stack arrays - they're only arrays when inside functions
  if (name === "FUNCNAME") {
    return (ctx.state.funcNameStack?.length ?? 0) > 0;
  }
  if (name === "BASH_LINENO") {
    return (ctx.state.callLineStack?.length ?? 0) > 0;
  }
  if (name === "BASH_SOURCE") {
    return (ctx.state.sourceStack?.length ?? 0) > 0;
  }
  // Check if it's an associative array
  if (ctx.state.associativeArrays?.has(name)) {
    return getAssocArrayKeys(ctx, name).length > 0;
  }
  // Check for indexed array elements
  return getArrayIndices(ctx, name).length > 0;
}

/**
 * Get the value of a variable, optionally checking nounset.
 * @param ctx - The interpreter context
 * @param name - The variable name
 * @param checkNounset - Whether to check for nounset (default true)
 */
export async function getVariable(
  ctx: InterpreterContext,
  name: string,
  checkNounset = true,
  _insideDoubleQuotes = false
): Promise<string> {
  // Special variables are always defined (never trigger nounset)
  switch (name) {
    case "?":
      return String(ctx.state.lastExitCode);
    case "$":
      return String(ctx.state.virtualPid);
    case "#":
      return ctx.state.env.get("#") || "0";
    case "@":
      return ctx.state.env.get("@") || "";
    case "_":
      // $_ is the last argument of the previous command
      return ctx.state.lastArg;
    case "-": {
      // $- returns current shell option flags
      // Bash always includes h (hashall) and B (braceexpand) by default
      // Note: pipefail has no short flag in $- (it's only set via -o pipefail)
      let flags = "";
      // h = hashall (always on in bash by default, we have hash table support)
      flags += "h";
      if (ctx.state.options.errexit) flags += "e";
      if (ctx.state.options.noglob) flags += "f";
      if (ctx.state.options.nounset) flags += "u";
      if (ctx.state.options.verbose) flags += "v";
      if (ctx.state.options.xtrace) flags += "x";
      // B = braceexpand (always on in our implementation)
      flags += "B";
      if (ctx.state.options.noclobber) flags += "C";
      // s = stdin reading (always on since we execute scripts passed as strings,
      // which is conceptually equivalent to reading from stdin like `bash < script.sh`)
      flags += "s";
      return flags;
    }
    case "*": {
      // $* uses first character of IFS as separator when inside double quotes
      // When IFS is empty string, no separator is used
      // When IFS is unset, space is used (default behavior)
      const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
      if (numParams === 0) return "";
      const params: string[] = [];
      for (let i = 1; i <= numParams; i++) {
        params.push(ctx.state.env.get(String(i)) || "");
      }
      return params.join(getIfsSeparator(ctx.state.env));
    }
    case "0":
      return ctx.state.env.get("0") || "bash";
    case "PWD":
      // Check if PWD is in env (might have been unset)
      return ctx.state.env.get("PWD") ?? "";
    case "OLDPWD":
      // Check if OLDPWD is in env (might have been unset)
      return ctx.state.env.get("OLDPWD") ?? "";
    case "PPID":
      // Virtual parent process ID (never exposes real host PPID)
      return String(ctx.state.virtualPpid);
    case "UID":
      // Virtual user ID (never exposes real host UID)
      return String(ctx.state.virtualUid);
    case "EUID":
      // Virtual effective user ID (never exposes real host EUID)
      return String(ctx.state.virtualUid);
    case "RANDOM":
      // Random number between 0 and 32767
      return String(Math.floor(Math.random() * 32768));
    case "SECONDS":
      // Seconds since shell started
      return String(Math.floor((Date.now() - ctx.state.startTime) / 1000));
    case "BASH_VERSION":
      // Simulated bash version (from shared metadata)
      return BASH_VERSION;
    case "!":
      // PID of most recent background job (0 if none)
      return String(ctx.state.lastBackgroundPid);
    case "BASHPID":
      // Current bash process ID (changes in subshells, unlike $$)
      return String(ctx.state.bashPid);
    case "LINENO":
      // Current line number being executed
      return String(ctx.state.currentLine);
    case "FUNCNAME": {
      // Return the first element (current function name) or handle unset
      const funcName = ctx.state.funcNameStack?.[0];
      if (funcName !== undefined) {
        return funcName;
      }
      // Outside functions, FUNCNAME is unset - check nounset
      if (checkNounset && ctx.state.options.nounset) {
        throw new NounsetError("FUNCNAME");
      }
      return "";
    }
    case "BASH_LINENO": {
      // Return the first element (line where current function was called) or handle unset
      const line = ctx.state.callLineStack?.[0];
      if (line !== undefined) {
        return String(line);
      }
      // Outside functions, BASH_LINENO is unset - check nounset
      if (checkNounset && ctx.state.options.nounset) {
        throw new NounsetError("BASH_LINENO");
      }
      return "";
    }
    case "BASH_SOURCE": {
      // Return the first element (source file where current function was defined) or handle unset
      const source = ctx.state.sourceStack?.[0];
      if (source !== undefined) {
        return source;
      }
      // Outside functions, BASH_SOURCE is unset - check nounset
      if (checkNounset && ctx.state.options.nounset) {
        throw new NounsetError("BASH_SOURCE");
      }
      return "";
    }
  }

  // Check for empty subscript: varName[] is invalid
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\[\]$/.test(name)) {
    throw new BadSubstitutionError(`\${${name}}`);
  }

  // Check for array subscript: varName[subscript]
  const bracketMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (bracketMatch) {
    let arrayName = bracketMatch[1];
    const subscript = bracketMatch[2];

    // Check if arrayName is a nameref - if so, resolve it
    if (isNameref(ctx, arrayName)) {
      const resolved = resolveNameref(ctx, arrayName);
      if (resolved && resolved !== arrayName) {
        // Check if resolved target itself has array subscript
        const resolvedBracket = resolved.match(
          /^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/
        );
        if (resolvedBracket) {
          // Nameref points to an array element like arr[2], so ref[0] is invalid
          // Return empty string (bash behavior)
          return "";
        }
        arrayName = resolved;
      }
    }

    if (subscript === "@" || subscript === "*") {
      // Get all array elements joined with space
      const elements = getArrayElements(ctx, arrayName);
      if (elements.length > 0) {
        return elements.map(([, v]) => v).join(" ");
      }
      // If no array elements, treat scalar variable as single-element array
      // ${s[@]} where s='abc' returns 'abc'
      const scalarValue = ctx.state.env.get(arrayName);
      if (scalarValue !== undefined) {
        return scalarValue;
      }
      return "";
    }

    // Handle special call stack arrays with numeric subscript
    if (arrayName === "FUNCNAME") {
      const index = Number.parseInt(subscript, 10);
      if (!Number.isNaN(index) && index >= 0) {
        return ctx.state.funcNameStack?.[index] ?? "";
      }
      return "";
    }
    if (arrayName === "BASH_LINENO") {
      const index = Number.parseInt(subscript, 10);
      if (!Number.isNaN(index) && index >= 0) {
        const line = ctx.state.callLineStack?.[index];
        return line !== undefined ? String(line) : "";
      }
      return "";
    }
    if (arrayName === "BASH_SOURCE") {
      const index = Number.parseInt(subscript, 10);
      if (!Number.isNaN(index) && index >= 0) {
        return ctx.state.sourceStack?.[index] ?? "";
      }
      return "";
    }

    const isAssoc = ctx.state.associativeArrays?.has(arrayName);

    if (isAssoc) {
      // For associative arrays, use subscript as string key
      // First unquote, then expand simple variable references for nameref support
      let key = unquoteKey(subscript);
      // Expand simple variable references like $var or ${var}
      key = expandSimpleVarsInSubscript(ctx, key);
      const value = ctx.state.env.get(`${arrayName}_${key}`);
      if (value === undefined && checkNounset && ctx.state.options.nounset) {
        throw new NounsetError(`${arrayName}[${subscript}]`);
      }
      return value || "";
    }

    // Evaluate subscript as arithmetic expression for indexed arrays
    // This handles: a[0], a[x], a[x+1], a[a[0]], a[b=2], etc.
    let index: number;
    if (/^-?\d+$/.test(subscript)) {
      // Simple numeric subscript - no need for full arithmetic parsing
      index = Number.parseInt(subscript, 10);
    } else {
      // Parse and evaluate as arithmetic expression
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, subscript);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        // Fall back to simple variable lookup for backwards compatibility
        const evalValue = ctx.state.env.get(subscript);
        index = evalValue ? Number.parseInt(evalValue, 10) : 0;
        if (Number.isNaN(index)) index = 0;
      }
    }

    // Handle negative indices - bash counts from max_index + 1
    // So a[-1] = a[max_index], a[-2] = a[max_index - 1], etc.
    if (index < 0) {
      const elements = getArrayElements(ctx, arrayName);
      const lineNum = ctx.state.currentLine;
      if (elements.length === 0) {
        // Empty array with negative index - output error to stderr and return empty
        ctx.state.expansionStderr =
          (ctx.state.expansionStderr || "") +
          `bash: line ${lineNum}: ${arrayName}: bad array subscript\n`;
        return "";
      }
      // Find the maximum index
      const maxIndex = Math.max(
        ...elements.map(([idx]) => (typeof idx === "number" ? idx : 0))
      );
      // Convert negative index to actual index
      const actualIdx = maxIndex + 1 + index;
      if (actualIdx < 0) {
        // Out of bounds negative index - output error to stderr and return empty
        ctx.state.expansionStderr =
          (ctx.state.expansionStderr || "") +
          `bash: line ${lineNum}: ${arrayName}: bad array subscript\n`;
        return "";
      }
      // Look up by actual index, not position
      const value = ctx.state.env.get(`${arrayName}_${actualIdx}`);
      return value || "";
    }

    const value = ctx.state.env.get(`${arrayName}_${index}`);
    if (value !== undefined) {
      return value;
    }
    // If array element doesn't exist, check if it's a scalar variable accessed as c[0]
    // In bash, c[0] for scalar c returns the value of c
    if (index === 0) {
      const scalarValue = ctx.state.env.get(arrayName);
      if (scalarValue !== undefined) {
        return scalarValue;
      }
    }
    if (checkNounset && ctx.state.options.nounset) {
      throw new NounsetError(`${arrayName}[${index}]`);
    }
    return "";
  }

  // Positional parameters ($1, $2, etc.) - check nounset
  if (/^[1-9][0-9]*$/.test(name)) {
    const value = ctx.state.env.get(name);
    if (value === undefined && checkNounset && ctx.state.options.nounset) {
      throw new NounsetError(name);
    }
    return value || "";
  }

  // Check if this is a nameref - resolve and get target's value
  if (isNameref(ctx, name)) {
    const resolved = resolveNameref(ctx, name);
    if (resolved === undefined) {
      // Circular nameref - error in bash, but we return empty string
      return "";
    }
    if (resolved !== name) {
      // Recursively get the target variable's value
      // (this handles if target is also a nameref, array, etc.)
      return await getVariable(
        ctx,
        resolved,
        checkNounset,
        _insideDoubleQuotes
      );
    }
    // Nameref points to empty/invalid target
    const value = ctx.state.env.get(name);
    // Empty nameref (no target) should trigger nounset error
    if (
      (value === undefined || value === "") &&
      checkNounset &&
      ctx.state.options.nounset
    ) {
      throw new NounsetError(name);
    }
    return value || "";
  }

  // Regular variables - check nounset
  const value = ctx.state.env.get(name);
  if (value !== undefined) {
    // Track tempenv access for local-unset scoping behavior
    // If this variable has a tempenv binding and we're reading it,
    // mark it as "accessed" so that local-unset will reveal the tempenv value
    if (ctx.state.tempEnvBindings?.some((b) => b.has(name))) {
      ctx.state.accessedTempEnvVars =
        ctx.state.accessedTempEnvVars || new Set();
      ctx.state.accessedTempEnvVars.add(name);
    }
    // Scalar value exists - return it
    return value;
  }

  // Check if plain variable name refers to an array (no scalar exists)
  // In bash, $a where a is an array returns ${a[0]} (first element)
  if (isArray(ctx, name)) {
    // Return the first element (index 0)
    const firstValue = ctx.state.env.get(`${name}_0`);
    if (firstValue !== undefined) {
      return firstValue;
    }
    // Array exists but no element at index 0 - return empty string
    return "";
  }

  // No value found - check nounset
  if (checkNounset && ctx.state.options.nounset) {
    throw new NounsetError(name);
  }
  return "";
}

/**
 * Check if a variable is set (exists in the environment).
 * Properly handles array subscripts (e.g., arr[0] -> arr_0).
 * @param ctx - The interpreter context
 * @param name - The variable name (possibly with array subscript)
 */
export async function isVariableSet(
  ctx: InterpreterContext,
  name: string
): Promise<boolean> {
  // Special variables that are always set
  // These match the variables handled in getVariable's switch statement
  const alwaysSetSpecialVars = new Set([
    "?",
    "$",
    "#",
    "_",
    "-",
    "0",
    "PPID",
    "UID",
    "EUID",
    "RANDOM",
    "SECONDS",
    "BASH_VERSION",
    "!",
    "BASHPID",
    "LINENO"
  ]);
  if (alwaysSetSpecialVars.has(name)) {
    return true;
  }

  // $@ and $* are considered "set" only if there are positional parameters
  if (name === "@" || name === "*") {
    const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
    return numParams > 0;
  }

  // PWD and OLDPWD are special - they are set unless explicitly unset
  // We check ctx.state.env for them since they can be unset
  if (name === "PWD" || name === "OLDPWD") {
    return ctx.state.env.has(name);
  }

  // Check for array subscript: varName[subscript]
  const bracketMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (bracketMatch) {
    let arrayName = bracketMatch[1];
    const subscript = bracketMatch[2];

    // Check if arrayName is a nameref - if so, resolve it
    if (isNameref(ctx, arrayName)) {
      const resolved = resolveNameref(ctx, arrayName);
      if (resolved && resolved !== arrayName) {
        const resolvedBracket = resolved.match(
          /^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/
        );
        if (resolvedBracket) {
          // Nameref points to an array element - treat as unset
          return false;
        }
        arrayName = resolved;
      }
    }

    // For @ or *, check if array has any elements
    if (subscript === "@" || subscript === "*") {
      const elements = getArrayElements(ctx, arrayName);
      if (elements.length > 0) return true;
      // Also check if scalar variable exists
      return ctx.state.env.has(arrayName);
    }

    const isAssoc = ctx.state.associativeArrays?.has(arrayName);

    if (isAssoc) {
      // For associative arrays, use subscript as string key (remove quotes if present)
      const key = unquoteKey(subscript);
      return ctx.state.env.has(`${arrayName}_${key}`);
    }

    // Evaluate subscript as arithmetic expression for indexed arrays
    let index: number;
    if (/^-?\d+$/.test(subscript)) {
      index = Number.parseInt(subscript, 10);
    } else {
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, subscript);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        const evalValue = ctx.state.env.get(subscript);
        index = evalValue ? Number.parseInt(evalValue, 10) : 0;
        if (Number.isNaN(index)) index = 0;
      }
    }

    // Handle negative indices
    if (index < 0) {
      const elements = getArrayElements(ctx, arrayName);
      if (elements.length === 0) return false;
      const maxIndex = Math.max(
        ...elements.map(([idx]) => (typeof idx === "number" ? idx : 0))
      );
      const actualIdx = maxIndex + 1 + index;
      if (actualIdx < 0) return false;
      return ctx.state.env.has(`${arrayName}_${actualIdx}`);
    }

    return ctx.state.env.has(`${arrayName}_${index}`);
  }

  // Check if this is a nameref - resolve and check target
  if (isNameref(ctx, name)) {
    const resolved = resolveNameref(ctx, name);
    if (resolved === undefined || resolved === name) {
      // Circular or invalid nameref
      return ctx.state.env.has(name);
    }
    // Recursively check the target
    return isVariableSet(ctx, resolved);
  }

  // Regular variable - check if scalar value exists
  if (ctx.state.env.has(name)) {
    return true;
  }

  // Check if plain variable name refers to an array (no scalar exists)
  // In bash, plain array name is "set" if array has elements
  if (isArray(ctx, name)) {
    // Array with elements is considered "set"
    return true;
  }

  return false;
}
