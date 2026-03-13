/**
 * Function Handling
 *
 * Handles shell function definition and invocation:
 * - Function definition (adding to function table)
 * - Function calls (with positional parameters and local scopes)
 */

import type {
  FunctionDefNode,
  HereDocNode,
  RedirectionNode,
  WordNode
} from "../ast/types";
import type { ExecResult } from "../types";
import { clearLocalVarStackForScope } from "./builtins/variable-assignment";
import { ExitError, ReturnError } from "./errors";
import { expandWord } from "./expansion";
import { OK, result, throwExecutionLimit } from "./helpers/result";
import { POSIX_SPECIAL_BUILTINS } from "./helpers/shell-constants";
import { applyRedirections, preExpandRedirectTargets } from "./redirections";
import type { InterpreterContext } from "./types";

export function executeFunctionDef(
  ctx: InterpreterContext,
  node: FunctionDefNode
): ExecResult {
  // In POSIX mode, special built-ins cannot be redefined as functions
  // This is a fatal error that exits the script
  if (ctx.state.options.posix && POSIX_SPECIAL_BUILTINS.has(node.name)) {
    const stderr = `bash: line ${ctx.state.currentLine}: \`${node.name}': is a special builtin\n`;
    throw new ExitError(2, "", stderr);
  }
  // Store the source file where this function is defined (for BASH_SOURCE)
  // Use currentSource from state, or the node's sourceFile, or "main" as default
  const funcWithSource: FunctionDefNode = {
    ...node,
    sourceFile: node.sourceFile ?? ctx.state.currentSource ?? "main"
  };
  ctx.state.functions.set(node.name, funcWithSource);
  return OK;
}

/**
 * Process input redirections to get stdin content for function calls.
 * Handles heredocs (<<, <<-), here-strings (<<<), and file input (<).
 */
async function processInputRedirections(
  ctx: InterpreterContext,
  redirections: RedirectionNode[]
): Promise<string> {
  let stdin = "";

  for (const redir of redirections) {
    if (
      (redir.operator === "<<" || redir.operator === "<<-") &&
      redir.target.type === "HereDoc"
    ) {
      const hereDoc = redir.target as HereDocNode;
      let content = await expandWord(ctx, hereDoc.content);
      // <<- strips leading tabs from each line
      if (hereDoc.stripTabs) {
        content = content
          .split("\n")
          .map((line) => line.replace(/^\t+/, ""))
          .join("\n");
      }
      // Only handle fd 0 (stdin) for now
      const fd = redir.fd ?? 0;
      if (fd === 0) {
        stdin = content;
      }
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      stdin = `${await expandWord(ctx, redir.target as WordNode)}\n`;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      const target = await expandWord(ctx, redir.target as WordNode);
      const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
      try {
        stdin = await ctx.fs.readFile(filePath);
      } catch {
        // File not found - stdin remains unchanged
      }
    }
  }

  return stdin;
}

export async function callFunction(
  ctx: InterpreterContext,
  func: FunctionDefNode,
  args: string[],
  stdin = "",
  callLine?: number
): Promise<ExecResult> {
  ctx.state.callDepth++;
  if (ctx.state.callDepth > ctx.limits.maxCallDepth) {
    ctx.state.callDepth--;
    throwExecutionLimit(
      `${func.name}: maximum recursion depth (${ctx.limits.maxCallDepth}) exceeded, increase executionLimits.maxCallDepth`,
      "recursion"
    );
  }

  // Track call stack for FUNCNAME, BASH_LINENO, and BASH_SOURCE
  // Initialize stacks if not present
  if (!ctx.state.funcNameStack) {
    ctx.state.funcNameStack = [];
  }
  if (!ctx.state.callLineStack) {
    ctx.state.callLineStack = [];
  }
  if (!ctx.state.sourceStack) {
    ctx.state.sourceStack = [];
  }

  // Push the function name and the line where it was called from
  ctx.state.funcNameStack.unshift(func.name);
  // Use provided callLine, or fall back to currentLine
  ctx.state.callLineStack.unshift(callLine ?? ctx.state.currentLine);
  // Push the source file where this function was defined (for BASH_SOURCE)
  ctx.state.sourceStack.unshift(func.sourceFile ?? "main");

  ctx.state.localScopes.push(new Map());

  // Push a new set for tracking exports made in this scope
  if (!ctx.state.localExportedVars) {
    ctx.state.localExportedVars = [];
  }
  ctx.state.localExportedVars.push(new Set());

  const savedPositional = new Map<string, string | undefined>();
  for (let i = 0; i < args.length; i++) {
    savedPositional.set(String(i + 1), ctx.state.env.get(String(i + 1)));
    ctx.state.env.set(String(i + 1), args[i]);
  }
  savedPositional.set("@", ctx.state.env.get("@"));
  savedPositional.set("#", ctx.state.env.get("#"));
  ctx.state.env.set("@", args.join(" "));
  ctx.state.env.set("#", String(args.length));

  const cleanup = (): void => {
    // Get the scope index before popping (for localVarStack cleanup)
    const scopeIndex = ctx.state.localScopes.length - 1;

    const localScope = ctx.state.localScopes.pop();
    if (localScope) {
      for (const [varName, originalValue] of localScope) {
        if (originalValue === undefined) {
          ctx.state.env.delete(varName);
        } else {
          ctx.state.env.set(varName, originalValue);
        }
      }
    }

    // Clear any localVarStack entries for this scope
    clearLocalVarStackForScope(ctx, scopeIndex);

    // Clear fullyUnsetLocals entries for this scope only
    if (ctx.state.fullyUnsetLocals) {
      for (const [name, entryScope] of ctx.state.fullyUnsetLocals.entries()) {
        if (entryScope === scopeIndex) {
          ctx.state.fullyUnsetLocals.delete(name);
        }
      }
    }

    // Pop local export tracking and restore export state
    // If a variable was exported only in this scope, unmark it
    if (ctx.state.localExportedVars && ctx.state.localExportedVars.length > 0) {
      const localExports = ctx.state.localExportedVars.pop();
      if (localExports) {
        for (const name of localExports) {
          // Remove the export attribute since the local scope is gone
          ctx.state.exportedVars?.delete(name);
        }
      }
    }

    for (const [key, value] of savedPositional) {
      if (value === undefined) {
        ctx.state.env.delete(key);
      } else {
        ctx.state.env.set(key, value);
      }
    }

    // Pop from call stack tracking
    ctx.state.funcNameStack?.shift();
    ctx.state.callLineStack?.shift();
    ctx.state.sourceStack?.shift();

    ctx.state.callDepth--;
  };

  // Pre-expand redirect targets BEFORE executing the function body.
  // This is critical because redirections like `fun() { echo $i; } > file$((i++))`
  // must evaluate $((i++)) before the body runs, so the body sees the new value.
  const { targets: preExpandedTargets, error: expandError } =
    await preExpandRedirectTargets(ctx, func.redirections);

  if (expandError) {
    cleanup();
    return result("", expandError, 1);
  }

  try {
    // Process redirections on the function definition to get stdin
    // Only use redirection-based stdin if no pipeline stdin was passed
    const redirectionStdin = await processInputRedirections(
      ctx,
      func.redirections
    );
    const effectiveStdin = stdin || redirectionStdin;
    const execResult = await ctx.executeCommand(func.body, effectiveStdin);
    cleanup();
    // Apply output redirections from the function definition using pre-expanded targets
    // e.g., fun() { echo hi; } 1>&2 should redirect output to stderr when called
    return applyRedirections(
      ctx,
      execResult,
      func.redirections,
      preExpandedTargets
    );
  } catch (error) {
    cleanup();
    // Handle return statement - convert to normal exit with the specified code
    if (error instanceof ReturnError) {
      const returnResult = result(error.stdout, error.stderr, error.exitCode);
      // Apply output redirections even when returning
      return applyRedirections(
        ctx,
        returnResult,
        func.redirections,
        preExpandedTargets
      );
    }
    throw error;
  }
}
