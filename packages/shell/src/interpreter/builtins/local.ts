/**
 * local - Declare local variables in functions builtin
 */

import { parseArithmeticExpression } from "../../parser/arithmetic-parser";
import { Parser } from "../../parser/parser";
import type { ExecResult } from "../../types";
import { evaluateArithmetic } from "../arithmetic";
import { getArrayIndices } from "../helpers/array";
import { markNameref } from "../helpers/nameref";
import { checkReadonlyError } from "../helpers/readonly";
import { failure, result } from "../helpers/result";
import { expandTildesInValue } from "../helpers/tilde";
import type { InterpreterContext } from "../types";
import { parseArrayElements } from "./declare-array-parsing";
import { markLocalVarDepth, pushLocalVarStack } from "./variable-assignment";

export async function handleLocal(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  if (ctx.state.localScopes.length === 0) {
    return failure("bash: local: can only be used in a function\n");
  }

  const currentScope = ctx.state.localScopes[ctx.state.localScopes.length - 1];
  let stderr = "";
  let exitCode = 0;
  let declareNameref = false;
  let declareArray = false;
  let _printMode = false;

  // Parse flags
  const processedArgs: string[] = [];
  for (const arg of args) {
    if (arg === "-n") {
      declareNameref = true;
    } else if (arg === "-a") {
      declareArray = true;
    } else if (arg === "-p") {
      _printMode = true;
    } else if (arg.startsWith("-") && !arg.includes("=")) {
      // Handle combined flags like -na
      for (const flag of arg.slice(1)) {
        if (flag === "n") declareNameref = true;
        else if (flag === "a") declareArray = true;
        else if (flag === "p") _printMode = true;
        // Other flags are ignored for now
      }
    } else {
      processedArgs.push(arg);
    }
  }

  // Handle local (with or without -p): print local variables in current scope when no args
  // Note: bash outputs local without "declare --" prefix, just "name=value"
  if (processedArgs.length === 0) {
    let stdout = "";
    // Get the names of local variables in current scope
    const localNames = Array.from(currentScope.keys())
      .filter((key) => !key.includes("_") || !key.match(/_\d+$/)) // Filter out array element keys
      .filter((key) => !key.includes("__length")) // Filter out length markers
      .sort();

    for (const name of localNames) {
      const value = ctx.state.env.get(name);
      if (value !== undefined) {
        stdout += `${name}=${value}\n`;
      }
    }
    return result(stdout, "", 0);
  }

  for (const arg of processedArgs) {
    let name: string;
    let value: string | undefined;

    // Check for array assignment: name=(...)
    const arrayMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\((.*)\)$/s);
    if (arrayMatch) {
      name = arrayMatch[1];
      const content = arrayMatch[2];

      // Validate variable name
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        stderr += `bash: local: \`${arg}': not a valid identifier\n`;
        exitCode = 1;
        continue;
      }

      // Check if variable is readonly
      checkReadonlyError(ctx, name, "bash");

      // Save previous value for scope restoration
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env.get(name));
        // Also save array elements
        const prefix = `${name}_`;
        for (const key of ctx.state.env.keys()) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env.get(key));
            }
          }
        }
      }

      // Clear existing array elements
      const prefix = `${name}_`;
      for (const key of ctx.state.env.keys()) {
        if (key.startsWith(prefix) && !key.includes("__")) {
          ctx.state.env.delete(key);
        }
      }

      // Parse array elements (respects quotes)
      const elements = parseArrayElements(content);
      for (let i = 0; i < elements.length; i++) {
        ctx.state.env.set(`${name}_${i}`, elements[i]);
      }
      ctx.state.env.set(`${name}__length`, String(elements.length));

      // Track local variable depth for bash-specific unset scoping
      markLocalVarDepth(ctx, name);

      // Mark as nameref if -n flag was used
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }

    // Check for array append syntax: local NAME+=(...)
    const arrayAppendMatch = arg.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)\+=\((.*)\)$/s
    );
    if (arrayAppendMatch) {
      name = arrayAppendMatch[1];
      const content = arrayAppendMatch[2];

      // Check if variable is readonly
      checkReadonlyError(ctx, name, "bash");

      // Save previous value for scope restoration
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env.get(name));
        // Also save array elements
        const prefix = `${name}_`;
        for (const key of ctx.state.env.keys()) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env.get(key));
            }
          }
        }
        const lengthKey = `${name}__length`;
        if (ctx.state.env.has(lengthKey) && !currentScope.has(lengthKey)) {
          currentScope.set(lengthKey, ctx.state.env.get(lengthKey));
        }
      }

      // Parse new elements
      const newElements = parseArrayElements(content);

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

      // Track local variable depth for bash-specific unset scoping
      markLocalVarDepth(ctx, name);

      // Mark as nameref if -n flag was used
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }

    // Check for += append syntax (scalar append)
    const appendMatch = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\+=(.*)$/);
    if (appendMatch) {
      name = appendMatch[1];
      const appendValue = expandTildesInValue(ctx, appendMatch[2]);

      // Check if variable is readonly
      checkReadonlyError(ctx, name, "bash");

      // Save previous value for scope restoration
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env.get(name));
      }

      // Append to existing value (or set if not defined)
      const existing = ctx.state.env.get(name) ?? "";
      ctx.state.env.set(name, existing + appendValue);

      // Track local variable depth for bash-specific unset scoping
      markLocalVarDepth(ctx, name);

      // Mark as nameref if -n flag was used
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }

    // Check for array index assignment: name[index]=value
    const indexMatch = arg.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)\[([^\]]+)\]=(.*)$/s
    );
    if (indexMatch) {
      name = indexMatch[1];
      const indexExpr = indexMatch[2];
      const indexValue = expandTildesInValue(ctx, indexMatch[3]);

      // Check if variable is readonly
      checkReadonlyError(ctx, name, "bash");

      // Save previous array values for scope restoration
      if (!currentScope.has(name)) {
        currentScope.set(name, ctx.state.env.get(name));
        // Also save array elements
        const prefix = `${name}_`;
        for (const key of ctx.state.env.keys()) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env.get(key));
            }
          }
        }
        const lengthKey = `${name}__length`;
        if (ctx.state.env.has(lengthKey) && !currentScope.has(lengthKey)) {
          currentScope.set(lengthKey, ctx.state.env.get(lengthKey));
        }
      }

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
      ctx.state.env.set(`${name}_${index}`, indexValue);

      // Update array length if needed
      const currentLength = parseInt(
        ctx.state.env.get(`${name}__length`) ?? "0",
        10
      );
      if (index >= currentLength) {
        ctx.state.env.set(`${name}__length`, String(index + 1));
      }

      // Track local variable depth for bash-specific unset scoping
      markLocalVarDepth(ctx, name);

      // Mark as nameref if -n flag was used
      if (declareNameref) {
        markNameref(ctx, name);
      }
      continue;
    }

    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      name = arg.slice(0, eqIdx);
      value = expandTildesInValue(ctx, arg.slice(eqIdx + 1));
    } else {
      name = arg;
    }

    // Validate variable name: must start with letter/underscore, contain only alphanumeric/_
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      stderr += `bash: local: \`${arg}': not a valid identifier\n`;
      exitCode = 1;
      continue;
    }

    // Check if variable was already local BEFORE we potentially add it to scope
    const wasAlreadyLocal = currentScope.has(name);

    // For bash's localvar-nest behavior: always push the current value to the stack
    // This allows nested local declarations (e.g., in nested evals) to each have
    // their own cell that can be unset independently.
    //
    // Special case for tempenv: the value we save depends on whether the tempenv
    // was "accessed" (read or written) before this local declaration:
    // - If accessed (read or mutated): save the current env value (tempenv or mutated)
    // - If NOT accessed at all: save the underlying value (for dynamic-unset to reveal)
    //   but local-unset will still just delete (value-unset)
    if (value !== undefined) {
      let savedValue: string | undefined = ctx.state.env.get(name);
      // Check if there's a tempenv binding
      if (ctx.state.tempEnvBindings) {
        const tempEnvAccessed = ctx.state.accessedTempEnvVars?.has(name);
        const tempEnvMutated = ctx.state.mutatedTempEnvVars?.has(name);
        if (!tempEnvAccessed && !tempEnvMutated) {
          // Tempenv was NOT accessed - save the underlying value for dynamic-unset
          for (let i = ctx.state.tempEnvBindings.length - 1; i >= 0; i--) {
            const bindings = ctx.state.tempEnvBindings[i];
            if (bindings.has(name)) {
              savedValue = bindings.get(name);
              break;
            }
          }
        }
        // If accessed or mutated, keep savedValue as ctx.state.env.get(name)
      }
      pushLocalVarStack(ctx, name, savedValue);
    }

    if (!wasAlreadyLocal) {
      // For bash 5.1 behavior: when saving the outer value for a local variable,
      // if there's a tempenv binding, save the underlying (global) value, not the tempenv value.
      // This way, dynamic-unset will correctly reveal the global value.
      let savedValue: string | undefined = ctx.state.env.get(name);
      if (ctx.state.tempEnvBindings) {
        for (let i = ctx.state.tempEnvBindings.length - 1; i >= 0; i--) {
          const bindings = ctx.state.tempEnvBindings[i];
          if (bindings.has(name)) {
            savedValue = bindings.get(name);
            break;
          }
        }
      }
      currentScope.set(name, savedValue);
      // Also save array elements if -a flag is used
      if (declareArray) {
        const prefix = `${name}_`;
        for (const key of ctx.state.env.keys()) {
          if (key.startsWith(prefix) && !key.includes("__")) {
            if (!currentScope.has(key)) {
              currentScope.set(key, ctx.state.env.get(key));
            }
          }
        }
        // Save length metadata too
        const lengthKey = `${name}__length`;
        if (ctx.state.env.has(lengthKey) && !currentScope.has(lengthKey)) {
          currentScope.set(lengthKey, ctx.state.env.get(lengthKey));
        }
      }
    }

    // If -a flag is used, create an empty local array
    if (declareArray && value === undefined) {
      // Clear existing array elements
      const prefix = `${name}_`;
      for (const key of ctx.state.env.keys()) {
        if (key.startsWith(prefix) && !key.includes("__")) {
          ctx.state.env.delete(key);
        }
      }
      // Mark as empty array
      ctx.state.env.set(`${name}__length`, "0");
    } else if (value !== undefined) {
      // Check if variable is readonly
      checkReadonlyError(ctx, name, "bash");

      // For namerefs, validate the target
      if (
        declareNameref &&
        value !== "" &&
        !/^[a-zA-Z_][a-zA-Z0-9_]*(\[.+\])?$/.test(value)
      ) {
        stderr += `bash: local: \`${value}': invalid variable name for name reference\n`;
        exitCode = 1;
        continue;
      }
      ctx.state.env.set(name, value);
      // If allexport is enabled (set -a), auto-export the variable
      if (ctx.state.options.allexport) {
        ctx.state.exportedVars = ctx.state.exportedVars || new Set();
        ctx.state.exportedVars.add(name);
      }
    } else {
      // `local v` without assignment: bash behavior is:
      // - If the variable is already local in current scope, keep its value
      // - If there's a tempenv binding, inherit that value
      // - Otherwise, the variable is unset (not inherited from global)
      const hasTempEnvBinding = ctx.state.tempEnvBindings?.some((bindings) =>
        bindings.has(name)
      );
      if (!wasAlreadyLocal && !hasTempEnvBinding) {
        // Not already local, no tempenv binding - make the variable unset
        ctx.state.env.delete(name);
      }
      // If already local or has tempenv binding, keep the current value
    }

    // Track local variable depth for bash-specific unset scoping
    markLocalVarDepth(ctx, name);

    // Mark as nameref if -n flag was used
    if (declareNameref) {
      markNameref(ctx, name);
    }
  }

  return result("", stderr, exitCode);
}
