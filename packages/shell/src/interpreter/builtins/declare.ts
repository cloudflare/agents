/**
 * declare/typeset - Declare variables and give them attributes
 *
 * Usage:
 *   declare              - List all variables
 *   declare -p           - List all variables (same as no args)
 *   declare NAME=value   - Declare variable with value
 *   declare -a NAME      - Declare indexed array
 *   declare -A NAME      - Declare associative array
 *   declare -r NAME      - Declare readonly variable
 *   declare -x NAME      - Export variable
 *   declare -g NAME      - Declare global variable (inside functions)
 *
 * Also aliased as 'typeset'
 */

import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import type { ExecResult } from "../../types";
import { evaluateArithmetic } from "../arithmetic";
import { clearArray, getArrayIndices } from "../helpers/array";
import {
  isNameref,
  markNameref,
  markNamerefBound,
  markNamerefInvalid,
  resolveNameref,
  targetExists,
  unmarkNameref
} from "../helpers/nameref";
import {
  checkReadonlyError,
  markExported,
  markReadonly,
  unmarkExported
} from "../helpers/readonly";
import { OK, result, success } from "../helpers/result";
import { expandTildesInValue } from "../helpers/tilde";
import type { InterpreterContext } from "../types";
import {
  parseArrayElements,
  parseAssocArrayLiteral
} from "./declare-array-parsing";
import {
  listAllVariables,
  listAssociativeArrays,
  listIndexedArrays,
  printAllVariables,
  printSpecificVariables
} from "./declare-print";
import {
  markLocalVarDepth,
  parseAssignment,
  setVariable
} from "./variable-assignment";

/**
 * Mark a variable as having the integer attribute.
 */
function markInteger(ctx: InterpreterContext, name: string): void {
  ctx.state.integerVars ??= new Set();
  ctx.state.integerVars.add(name);
}

/**
 * Check if a variable has the integer attribute.
 */
export function isInteger(ctx: InterpreterContext, name: string): boolean {
  return ctx.state.integerVars?.has(name) ?? false;
}

/**
 * Mark a variable as having the lowercase attribute.
 */
function markLowercase(ctx: InterpreterContext, name: string): void {
  ctx.state.lowercaseVars ??= new Set();
  ctx.state.lowercaseVars.add(name);
  // -l and -u are mutually exclusive; -l clears -u
  ctx.state.uppercaseVars?.delete(name);
}

/**
 * Check if a variable has the lowercase attribute.
 */
function isLowercase(ctx: InterpreterContext, name: string): boolean {
  return ctx.state.lowercaseVars?.has(name) ?? false;
}

/**
 * Mark a variable as having the uppercase attribute.
 */
function markUppercase(ctx: InterpreterContext, name: string): void {
  ctx.state.uppercaseVars ??= new Set();
  ctx.state.uppercaseVars.add(name);
  // -l and -u are mutually exclusive; -u clears -l
  ctx.state.lowercaseVars?.delete(name);
}

/**
 * Check if a variable has the uppercase attribute.
 */
function isUppercase(ctx: InterpreterContext, name: string): boolean {
  return ctx.state.uppercaseVars?.has(name) ?? false;
}

/**
 * Apply case transformation based on variable attributes.
 * Returns the transformed value.
 */
export function applyCaseTransform(
  ctx: InterpreterContext,
  name: string,
  value: string
): string {
  if (isLowercase(ctx, name)) {
    return value.toLowerCase();
  }
  if (isUppercase(ctx, name)) {
    return value.toUpperCase();
  }
  return value;
}

/**
 * Evaluate a value as arithmetic if the variable has integer attribute.
 * Returns the evaluated string value.
 */
async function evaluateIntegerValue(
  ctx: InterpreterContext,
  value: string
): Promise<string> {
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, value);
    const result = await evaluateArithmetic(ctx, arithAst.expression);
    return String(result);
  } catch {
    // If parsing fails, return 0 (bash behavior for invalid expressions)
    return "0";
  }
}

/**
 * Parse array assignment syntax: name[index]=value
 * Handles nested brackets like a[a[0]=1]=X
 * Returns null if not an array assignment pattern
 */
function parseArrayAssignment(
  arg: string
): { name: string; indexExpr: string; value: string } | null {
  // Check for variable name at start
  const nameMatch = arg.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!nameMatch) return null;

  const name = nameMatch[0];
  let pos = name.length;

  // Must have [ after name
  if (arg[pos] !== "[") return null;

  // Find matching ] using bracket depth tracking
  let depth = 0;
  const subscriptStart = pos + 1;
  for (; pos < arg.length; pos++) {
    if (arg[pos] === "[") depth++;
    else if (arg[pos] === "]") {
      depth--;
      if (depth === 0) break;
    }
  }

  // If depth is not 0, brackets are unbalanced
  if (depth !== 0) return null;

  const indexExpr = arg.slice(subscriptStart, pos);
  pos++; // skip closing ]

  // Must have = after ]
  if (arg[pos] !== "=") return null;
  pos++; // skip =

  const value = arg.slice(pos);

  return { name, indexExpr, value };
}

export async function handleDeclare(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  // Parse flags
  let declareArray = false;
  let declareAssoc = false;
  let declareReadonly = false;
  let declareExport = false;
  let printMode = false;
  let declareNameref = false;
  let removeNameref = false;
  let removeArray = false; // +a flag: remove array attribute, treat value as scalar
  let removeExport = false; // +x flag: remove export attribute
  let declareInteger = false;
  let declareLowercase = false;
  let declareUppercase = false;
  let functionMode = false; // -f flag: function definitions
  let functionNamesOnly = false; // -F flag: function names only
  let declareGlobal = false; // -g flag: declare global variable (inside functions)
  const processedArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-a") {
      declareArray = true;
    } else if (arg === "-A") {
      declareAssoc = true;
    } else if (arg === "-r") {
      declareReadonly = true;
    } else if (arg === "-x") {
      declareExport = true;
    } else if (arg === "-p") {
      printMode = true;
    } else if (arg === "-n") {
      declareNameref = true;
    } else if (arg === "+n") {
      removeNameref = true;
    } else if (arg === "+a") {
      removeArray = true;
    } else if (arg === "+x") {
      removeExport = true;
    } else if (arg === "--") {
      // End of options, rest are arguments
      processedArgs.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("+")) {
      // Handle + flags that remove attributes
      // Valid + flags: +a, +n, +x, +r, +i, +f, +F
      for (const flag of arg.slice(1)) {
        if (flag === "n") removeNameref = true;
        else if (flag === "a") removeArray = true;
        else if (flag === "x") removeExport = true;
        else if (flag === "r") {
          // +r is accepted by bash but has no effect (can't un-readonly)
          // We just ignore it silently
        } else if (flag === "i") {
          // +i removes integer attribute - we just ignore since we don't track removal
        } else if (flag === "f" || flag === "F") {
          // +f/+F for function listing - we just ignore
        } else {
          // Unknown flag - bash returns exit code 2 for invalid options
          return result("", `bash: typeset: +${flag}: invalid option\n`, 2);
        }
      }
    } else if (arg === "-i") {
      declareInteger = true;
    } else if (arg === "-l") {
      declareLowercase = true;
    } else if (arg === "-u") {
      declareUppercase = true;
    } else if (arg === "-f") {
      functionMode = true;
    } else if (arg === "-F") {
      functionNamesOnly = true;
    } else if (arg === "-g") {
      declareGlobal = true;
    } else if (arg.startsWith("-")) {
      // Handle combined flags like -ar
      for (const flag of arg.slice(1)) {
        if (flag === "a") declareArray = true;
        else if (flag === "A") declareAssoc = true;
        else if (flag === "r") declareReadonly = true;
        else if (flag === "x") declareExport = true;
        else if (flag === "p") printMode = true;
        else if (flag === "n") declareNameref = true;
        else if (flag === "i") declareInteger = true;
        else if (flag === "l") declareLowercase = true;
        else if (flag === "u") declareUppercase = true;
        else if (flag === "f") functionMode = true;
        else if (flag === "F") functionNamesOnly = true;
        else if (flag === "g") declareGlobal = true;
        else {
          // Unknown flag - bash returns exit code 2 for invalid options
          return result("", `bash: typeset: -${flag}: invalid option\n`, 2);
        }
      }
    } else {
      processedArgs.push(arg);
    }
  }

  // Determine if we should create local variables (inside a function, without -g flag)
  const isInsideFunction = ctx.state.localScopes.length > 0;
  const createLocal = isInsideFunction && !declareGlobal;

  // Helper to save variable to local scope (for restoration when function exits)
  const saveToLocalScope = (name: string): void => {
    if (!createLocal) return;
    const currentScope =
      ctx.state.localScopes[ctx.state.localScopes.length - 1];
    if (!currentScope.has(name)) {
      currentScope.set(name, ctx.state.env.get(name));
    }
  };

  // Helper to save array elements to local scope
  const saveArrayToLocalScope = (name: string): void => {
    if (!createLocal) return;
    const currentScope =
      ctx.state.localScopes[ctx.state.localScopes.length - 1];
    // Save the base variable
    if (!currentScope.has(name)) {
      currentScope.set(name, ctx.state.env.get(name));
    }
    // Save array elements
    const prefix = `${name}_`;
    for (const key of ctx.state.env.keys()) {
      if (key.startsWith(prefix) && !key.includes("__")) {
        if (!currentScope.has(key)) {
          currentScope.set(key, ctx.state.env.get(key));
        }
      }
    }
    // Save length metadata
    const lengthKey = `${name}__length`;
    if (ctx.state.env.has(lengthKey) && !currentScope.has(lengthKey)) {
      currentScope.set(lengthKey, ctx.state.env.get(lengthKey));
    }
  };

  // Helper to mark variable as local after setting it
  const markAsLocalIfNeeded = (name: string): void => {
    if (createLocal) {
      markLocalVarDepth(ctx, name);
    }
  };

  // Handle declare -F (function names only)
  if (functionNamesOnly) {
    if (processedArgs.length === 0) {
      // List all function names in sorted order
      const funcNames = Array.from(ctx.state.functions.keys()).sort();
      let stdout = "";
      for (const name of funcNames) {
        stdout += `declare -f ${name}\n`;
      }
      return success(stdout);
    }
    // With args, check if functions exist and output their names
    let allExist = true;
    let stdout = "";
    for (const name of processedArgs) {
      if (ctx.state.functions.has(name)) {
        stdout += `${name}\n`;
      } else {
        allExist = false;
      }
    }
    return result(stdout, "", allExist ? 0 : 1);
  }

  // Handle declare -f (function definitions)
  if (functionMode) {
    if (processedArgs.length === 0) {
      // List all function definitions - we don't store source, so just list names
      let stdout = "";
      const funcNames = Array.from(ctx.state.functions.keys()).sort();
      for (const name of funcNames) {
        // Without source tracking, we can't print the full definition
        // Just print the function name declaration
        stdout += `${name} ()\n{\n    # function body\n}\n`;
      }
      return success(stdout);
    }
    // Check if all specified functions exist (exit code is the main use case)
    let allExist = true;
    for (const name of processedArgs) {
      if (!ctx.state.functions.has(name)) {
        allExist = false;
      }
    }
    return result("", "", allExist ? 0 : 1);
  }

  // Print mode with specific variable names: declare -p varname
  if (printMode && processedArgs.length > 0) {
    return printSpecificVariables(ctx, processedArgs);
  }

  // Print mode without args (declare -p): list all variables with attributes
  // When filtering flags are also set (-x, -r, -n, -a, -A), only show matching variables
  if (printMode && processedArgs.length === 0) {
    return printAllVariables(ctx, {
      filterExport: declareExport,
      filterReadonly: declareReadonly,
      filterNameref: declareNameref,
      filterIndexedArray: declareArray,
      filterAssocArray: declareAssoc
    });
  }

  // Handle declare -A without arguments: list all associative arrays
  if (processedArgs.length === 0 && declareAssoc && !printMode) {
    return listAssociativeArrays(ctx);
  }

  // Handle declare -a without arguments: list all indexed arrays
  if (processedArgs.length === 0 && declareArray && !printMode) {
    return listIndexedArrays(ctx);
  }

  // No args: list all variables (without -p flag, just print name=value)
  if (processedArgs.length === 0 && !printMode) {
    return listAllVariables(ctx);
  }

  // Track errors during processing
  let stderr = "";
  let exitCode = 0;

  // Process each argument
  for (const arg of processedArgs) {
    // Check for array assignment: name=(...)
    // When +a (removeArray) is set, don't interpret (...) as array syntax - treat it as a literal string
    const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\((.*)\)$/s);
    if (arrayMatch && !removeArray) {
      const name = arrayMatch[1];
      const content = arrayMatch[2];

      // Check for type conversion errors
      // Cannot convert indexed array to associative array
      if (declareAssoc) {
        const existingIndices = getArrayIndices(ctx, name);
        if (existingIndices.length > 0) {
          stderr += `bash: declare: ${name}: cannot convert indexed to associative array\n`;
          exitCode = 1;
          continue;
        }
      }
      // Cannot convert associative array to indexed array
      if (declareArray || (!declareAssoc && !declareArray)) {
        // If no -A flag is set and variable is already an assoc array, error
        if (ctx.state.associativeArrays?.has(name)) {
          stderr += `bash: declare: ${name}: cannot convert associative to indexed array\n`;
          exitCode = 1;
          continue;
        }
      }

      // Save to local scope before modifying (for local variable restoration)
      saveArrayToLocalScope(name);

      // Track associative array declaration
      if (declareAssoc) {
        ctx.state.associativeArrays ??= new Set();
        ctx.state.associativeArrays.add(name);
      }

      // Clear existing array elements before assigning new ones
      // This ensures arr=(a b c); arr=(d e) results in just (d e), not merged
      clearArray(ctx, name);
      // Also clear the scalar value and length marker
      ctx.state.env.delete(name);
      ctx.state.env.delete(`${name}__length`);

      // Check if this is associative array literal syntax: (['key']=value ...)
      if (declareAssoc && content.includes("[")) {
        const entries = parseAssocArrayLiteral(content);
        for (const [key, rawValue] of entries) {
          // Apply tilde expansion to the value
          const value = expandTildesInValue(ctx, rawValue);
          ctx.state.env.set(`${name}_${key}`, value);
        }
      } else if (declareAssoc) {
        // For associative arrays without [key]=value syntax,
        // bash treats bare values as alternating key-value pairs
        // e.g., (1 2 3) becomes ['1']=2, ['3']=''
        const elements = parseArrayElements(content);
        for (let i = 0; i < elements.length; i += 2) {
          const key = elements[i];
          const value =
            i + 1 < elements.length
              ? expandTildesInValue(ctx, elements[i + 1])
              : "";
          ctx.state.env.set(`${name}_${key}`, value);
        }
      } else {
        // Parse as indexed array elements
        const elements = parseArrayElements(content);
        // Check if any element has [index]=value syntax (index can be number, variable, or expression)
        const hasKeyedElements = elements.some((el) => /^\[[^\]]+\]=/.test(el));
        if (hasKeyedElements) {
          // Handle sparse array with [index]=value syntax
          // Track current index - non-keyed elements use previous keyed index + 1
          let currentIndex = 0;
          for (const element of elements) {
            // Match [index]=value where index can be any expression (not just digits)
            const keyedMatch = element.match(/^\[([^\]]+)\]=(.*)$/);
            if (keyedMatch) {
              const indexExpr = keyedMatch[1];
              const rawValue = keyedMatch[2];
              const value = expandTildesInValue(ctx, rawValue);
              // Evaluate index as arithmetic expression (handles numbers, variables, expressions)
              let index: number;
              if (/^-?\d+$/.test(indexExpr)) {
                index = Number.parseInt(indexExpr, 10);
              } else {
                // Evaluate as arithmetic expression
                try {
                  const parser = new Parser();
                  const arithAst = parseArithmeticExpression(parser, indexExpr);
                  index = await evaluateArithmetic(ctx, arithAst.expression);
                } catch {
                  // If parsing fails, treat as 0 (like unset variable)
                  index = 0;
                }
              }
              ctx.state.env.set(`${name}_${index}`, value);
              currentIndex = index + 1;
            } else {
              // Non-keyed element: use currentIndex and increment
              const value = expandTildesInValue(ctx, element);
              ctx.state.env.set(`${name}_${currentIndex}`, value);
              currentIndex++;
            }
          }
        } else {
          // Simple sequential assignment
          for (let i = 0; i < elements.length; i++) {
            ctx.state.env.set(`${name}_${i}`, elements[i]);
          }
          // Store array length marker
          ctx.state.env.set(`${name}__length`, String(elements.length));
        }
      }

      // Mark as local if inside a function
      markAsLocalIfNeeded(name);

      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      continue;
    }

    // Handle nameref removal (+n)
    if (removeNameref) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      unmarkNameref(ctx, name);
      // After removing nameref, the value stays as-is (it's now a regular variable)
      if (!arg.includes("=")) {
        continue;
      }
    }

    // Handle export removal (+x)
    if (removeExport) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      unmarkExported(ctx, name);
      // After removing export, continue processing to set any value if provided
      if (!arg.includes("=")) {
        continue;
      }
    }

    // Check for array index assignment: name[index]=value
    // We need to handle nested brackets like a[a[0]=1]=X
    // The regex approach doesn't work for nested brackets, so we parse manually
    const arrayAssignMatch = parseArrayAssignment(arg);
    if (arrayAssignMatch) {
      const { name, indexExpr, value } = arrayAssignMatch;

      // Check if variable is readonly
      const error = checkReadonlyError(ctx, name);
      if (error) return error;

      // Save to local scope before modifying
      saveArrayToLocalScope(name);

      // Evaluate the index (can be arithmetic expression)
      let index: number;
      try {
        const parser = new Parser();
        const arithAst = parseArithmeticExpression(parser, indexExpr);
        index = await evaluateArithmetic(ctx, arithAst.expression);
      } catch {
        // If parsing fails, try to parse as simple number
        const num = parseInt(indexExpr, 10);
        index = Number.isNaN(num) ? 0 : num;
      }

      // Set the array element
      ctx.state.env.set(`${name}_${index}`, value);

      // Update array length if needed
      const currentLength = parseInt(
        ctx.state.env.get(`${name}__length`) ?? "0",
        10
      );
      if (index >= currentLength) {
        ctx.state.env.set(`${name}__length`, String(index + 1));
      }

      // Mark as local if inside a function
      markAsLocalIfNeeded(name);

      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      continue;
    }

    // Check for array append syntax: typeset NAME+=(...)
    const arrayAppendMatch = arg.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)\+=\((.*)\)$/s
    );
    if (arrayAppendMatch && !removeArray) {
      const name = arrayAppendMatch[1];
      const content = arrayAppendMatch[2];

      // Check if variable is readonly
      const error = checkReadonlyError(ctx, name);
      if (error) return error;

      // Save to local scope before modifying
      saveArrayToLocalScope(name);

      // Parse new elements
      const newElements = parseArrayElements(content);

      // Check if this is an associative array
      if (ctx.state.associativeArrays?.has(name)) {
        // For associative arrays, we need keyed elements: ([key]=value ...)
        const entries = parseAssocArrayLiteral(content);
        for (const [key, rawValue] of entries) {
          const value = expandTildesInValue(ctx, rawValue);
          ctx.state.env.set(`${name}_${key}`, value);
        }
      } else {
        // For indexed arrays, get current highest index and append
        const existingIndices = getArrayIndices(ctx, name);

        // If variable was a scalar, convert it to array element 0
        let startIndex = 0;
        const scalarValue = ctx.state.env.get(name);
        if (existingIndices.length === 0 && scalarValue !== undefined) {
          // Variable exists as scalar - convert to array element 0
          ctx.state.env.set(`${name}_0`, scalarValue);
          ctx.state.env.delete(name);
          startIndex = 1;
        } else if (existingIndices.length > 0) {
          // Find highest existing index + 1
          startIndex = Math.max(...existingIndices) + 1;
        }

        // Append new elements
        for (let i = 0; i < newElements.length; i++) {
          ctx.state.env.set(
            `${name}_${startIndex + i}`,
            expandTildesInValue(ctx, newElements[i])
          );
        }

        // Update length marker
        const newLength = startIndex + newElements.length;
        ctx.state.env.set(`${name}__length`, String(newLength));
      }

      // Mark as local if inside a function
      markAsLocalIfNeeded(name);

      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      continue;
    }

    // Check for += append syntax: typeset NAME+=value (scalar append)
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      const name = appendMatch[1];
      let appendValue = expandTildesInValue(ctx, appendMatch[2]);

      // Check if variable is readonly
      const error = checkReadonlyError(ctx, name);
      if (error) return error;

      // Save to local scope before modifying
      saveToLocalScope(name);

      // Mark as integer if -i flag was used
      if (declareInteger) {
        markInteger(ctx, name);
      }

      // Mark as lowercase if -l flag was used
      if (declareLowercase) {
        markLowercase(ctx, name);
      }

      // Mark as uppercase if -u flag was used
      if (declareUppercase) {
        markUppercase(ctx, name);
      }

      // Check if this is an array (bash appends to element 0 for array+=string)
      const existingIndices = getArrayIndices(ctx, name);
      const isArray =
        existingIndices.length > 0 || ctx.state.associativeArrays?.has(name);

      // If variable has integer attribute, evaluate as arithmetic and add
      if (isInteger(ctx, name)) {
        const existing = ctx.state.env.get(name) ?? "0";
        const existingNum = parseInt(existing, 10) || 0;
        const appendNum =
          parseInt(await evaluateIntegerValue(ctx, appendValue), 10) || 0;
        appendValue = String(existingNum + appendNum);
        ctx.state.env.set(name, appendValue);
      } else if (isArray) {
        // For arrays, append to element 0 (bash behavior)
        appendValue = applyCaseTransform(ctx, name, appendValue);
        const element0Key = `${name}_0`;
        const existing = ctx.state.env.get(element0Key) ?? "";
        ctx.state.env.set(element0Key, existing + appendValue);
      } else {
        // Apply case transformation
        appendValue = applyCaseTransform(ctx, name, appendValue);

        // Append to existing value (or set if not defined)
        const existing = ctx.state.env.get(name) ?? "";
        ctx.state.env.set(name, existing + appendValue);
      }

      // Mark as local if inside a function
      markAsLocalIfNeeded(name);

      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      // If allexport is enabled (set -a), auto-export the variable
      if (ctx.state.options.allexport && !removeExport) {
        ctx.state.exportedVars = ctx.state.exportedVars || new Set();
        ctx.state.exportedVars.add(name);
      }
      continue;
    }

    // Check for scalar assignment: name=value
    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const name = arg.slice(0, eqIdx);
      let value = arg.slice(eqIdx + 1);

      // Validate variable name
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        stderr += `bash: typeset: \`${name}': not a valid identifier\n`;
        exitCode = 1;
        continue;
      }

      // Check if variable is readonly
      const error = checkReadonlyError(ctx, name);
      if (error) return error;

      // Save to local scope before modifying
      saveToLocalScope(name);

      // For namerefs being declared with a value, store the target name
      // (don't follow the reference, just store what variable it points to)
      if (declareNameref) {
        // Validate the target: must be a valid variable name or array subscript,
        // not a special parameter like @, *, #, etc.
        // bash gives an error: "declare: `@': invalid variable name for name reference"
        if (value !== "" && !/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(value)) {
          stderr += `bash: declare: \`${value}': invalid variable name for name reference\n`;
          exitCode = 1;
          continue;
        }
        ctx.state.env.set(name, value);
        markNameref(ctx, name);
        // If the target variable exists at creation time, mark this nameref as "bound".
        // Bound namerefs always resolve through to their target, even if unset later.
        // Unbound namerefs (target never existed) act like regular variables.
        if (value !== "" && targetExists(ctx, value)) {
          markNamerefBound(ctx, name);
        }
        markAsLocalIfNeeded(name);
        if (declareReadonly) {
          markReadonly(ctx, name);
        }
        if (declareExport) {
          markExported(ctx, name);
        }
        continue;
      }

      // Mark as integer if -i flag was used
      if (declareInteger) {
        markInteger(ctx, name);
      }

      // Mark as lowercase if -l flag was used
      if (declareLowercase) {
        markLowercase(ctx, name);
      }

      // Mark as uppercase if -u flag was used
      if (declareUppercase) {
        markUppercase(ctx, name);
      }

      // If variable has integer attribute (either just declared or previously), evaluate as arithmetic
      if (isInteger(ctx, name)) {
        value = await evaluateIntegerValue(ctx, value);
      }

      // Apply case transformation based on variable attributes
      value = applyCaseTransform(ctx, name, value);

      // If this is an existing nameref (not being declared as one), write through it
      if (isNameref(ctx, name)) {
        const resolved = resolveNameref(ctx, name);
        if (resolved && resolved !== name) {
          ctx.state.env.set(resolved, value);
        } else {
          ctx.state.env.set(name, value);
        }
      } else {
        ctx.state.env.set(name, value);
      }

      // Mark as local if inside a function
      markAsLocalIfNeeded(name);

      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
      // If allexport is enabled (set -a), auto-export the variable
      if (ctx.state.options.allexport && !removeExport) {
        ctx.state.exportedVars = ctx.state.exportedVars || new Set();
        ctx.state.exportedVars.add(name);
      }
    } else {
      // Just declare without value
      const name = arg;

      // Validate variable name
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        stderr += `bash: typeset: \`${name}': not a valid identifier\n`;
        exitCode = 1;
        continue;
      }

      // Save to local scope before modifying
      if (declareArray || declareAssoc) {
        saveArrayToLocalScope(name);
      } else {
        saveToLocalScope(name);
      }

      // For declare -n without a value, just mark as nameref
      if (declareNameref) {
        markNameref(ctx, name);
        // If the existing value is not a valid variable name, mark as invalid nameref.
        // Invalid namerefs act as regular variables (no resolution).
        const existingValue = ctx.state.env.get(name);
        if (
          existingValue !== undefined &&
          existingValue !== "" &&
          !/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(existingValue)
        ) {
          markNamerefInvalid(ctx, name);
        } else if (existingValue && targetExists(ctx, existingValue)) {
          // If target exists at creation time, mark as bound
          markNamerefBound(ctx, name);
        }
        markAsLocalIfNeeded(name);
        if (declareReadonly) {
          markReadonly(ctx, name);
        }
        if (declareExport) {
          markExported(ctx, name);
        }
        continue;
      }

      // Mark as integer if -i flag was used
      if (declareInteger) {
        markInteger(ctx, name);
      }

      // Mark as lowercase if -l flag was used
      if (declareLowercase) {
        markLowercase(ctx, name);
      }

      // Mark as uppercase if -u flag was used
      if (declareUppercase) {
        markUppercase(ctx, name);
      }

      // Track associative array declaration
      if (declareAssoc) {
        // Check if this is already an indexed array - can't convert
        const existingIndices = getArrayIndices(ctx, name);
        if (existingIndices.length > 0) {
          // bash: declare: z: cannot convert indexed to associative array
          stderr += `bash: declare: ${name}: cannot convert indexed to associative array\n`;
          exitCode = 1;
          continue;
        }
        ctx.state.associativeArrays ??= new Set();
        ctx.state.associativeArrays.add(name);
      }

      // Check if any array elements exist (numeric or string keys)
      const hasArrayElements = Array.from(ctx.state.env.keys()).some(
        (key) =>
          key.startsWith(`${name}_`) && !key.startsWith(`${name}__length`)
      );
      if (!ctx.state.env.has(name) && !hasArrayElements) {
        // If declaring as array, initialize empty array
        if (declareArray || declareAssoc) {
          ctx.state.env.set(`${name}__length`, "0");
        } else {
          // Mark variable as declared but don't set a value
          // This distinguishes "declare x" (unset) from "declare x=" (empty string)
          ctx.state.declaredVars ??= new Set();
          ctx.state.declaredVars.add(name);
        }
      }

      // Mark as local if inside a function
      markAsLocalIfNeeded(name);

      if (declareReadonly) {
        markReadonly(ctx, name);
      }
      if (declareExport) {
        markExported(ctx, name);
      }
    }
  }

  return result("", stderr, exitCode);
}

/**
 * readonly - Declare readonly variables
 *
 * Usage:
 *   readonly NAME=value   - Declare readonly variable
 *   readonly NAME         - Mark existing variable as readonly
 */
export async function handleReadonly(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  // Parse flags
  let _declareArray = false;
  let _declareAssoc = false;
  let _printMode = false;
  const processedArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-a") {
      _declareArray = true;
    } else if (arg === "-A") {
      _declareAssoc = true;
    } else if (arg === "-p") {
      _printMode = true;
    } else if (arg === "--") {
      processedArgs.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith("-")) {
      processedArgs.push(arg);
    }
  }

  // When called with no args (or just -p), list readonly variables
  if (processedArgs.length === 0) {
    let stdout = "";
    const readonlyNames = Array.from(ctx.state.readonlyVars || []).sort();
    for (const name of readonlyNames) {
      const value = ctx.state.env.get(name);
      if (value !== undefined) {
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        stdout += `declare -r ${name}="${escapedValue}"\n`;
      }
    }
    return success(stdout);
  }

  for (const arg of processedArgs) {
    // Check for array append syntax: readonly NAME+=(...)
    const arrayAppendMatch = arg.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)\+=\((.*)\)$/s
    );
    if (arrayAppendMatch) {
      const name = arrayAppendMatch[1];
      const content = arrayAppendMatch[2];

      // Check if variable is already readonly
      const error = checkReadonlyError(ctx, name);
      if (error) return error;

      // Parse new elements
      const newElements = parseArrayElements(content);

      // Check if this is an associative array
      if (ctx.state.associativeArrays?.has(name)) {
        // For associative arrays, we need keyed elements: ([key]=value ...)
        const entries = parseAssocArrayLiteral(content);
        for (const [key, rawValue] of entries) {
          const value = expandTildesInValue(ctx, rawValue);
          ctx.state.env.set(`${name}_${key}`, value);
        }
      } else {
        // For indexed arrays, get current highest index and append
        const existingIndices = getArrayIndices(ctx, name);

        // If variable was a scalar, convert it to array element 0
        let startIndex = 0;
        const scalarValue = ctx.state.env.get(name);
        if (existingIndices.length === 0 && scalarValue !== undefined) {
          // Variable exists as scalar - convert to array element 0
          ctx.state.env.set(`${name}_0`, scalarValue);
          ctx.state.env.delete(name);
          startIndex = 1;
        } else if (existingIndices.length > 0) {
          // Find highest existing index + 1
          startIndex = Math.max(...existingIndices) + 1;
        }

        // Append new elements
        for (let i = 0; i < newElements.length; i++) {
          ctx.state.env.set(
            `${name}_${startIndex + i}`,
            expandTildesInValue(ctx, newElements[i])
          );
        }

        // Update length marker
        const newLength = startIndex + newElements.length;
        ctx.state.env.set(`${name}__length`, String(newLength));
      }

      markReadonly(ctx, name);
      continue;
    }

    // Check for += append syntax: readonly NAME+=value (scalar append)
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      const name = appendMatch[1];
      const appendValue = expandTildesInValue(ctx, appendMatch[2]);

      // Check if variable is already readonly
      const error = checkReadonlyError(ctx, name);
      if (error) return error;

      // Append to existing value (or set if not defined)
      const existing = ctx.state.env.get(name) ?? "";
      ctx.state.env.set(name, existing + appendValue);
      markReadonly(ctx, name);
      continue;
    }

    const assignment = parseAssignment(arg);

    // If no value provided, just mark as readonly
    if (assignment.value === undefined && !assignment.isArray) {
      markReadonly(ctx, assignment.name);
      continue;
    }

    // Set variable and mark as readonly
    const error = await setVariable(ctx, assignment, { makeReadonly: true });
    if (error) {
      return error;
    }
  }

  return OK;
}
