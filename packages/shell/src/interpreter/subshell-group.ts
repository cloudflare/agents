/**
 * Subshell, Group, and Script Execution
 *
 * Handles execution of subshells (...), groups { ...; }, and user scripts
 */

import type {
  GroupNode,
  HereDocNode,
  ScriptNode,
  StatementNode,
  SubshellNode,
  WordNode
} from "../ast/types";
import { Parser } from "../parser/parser";
import type { ParseException } from "../parser/types";
import type { ExecResult } from "../types";
import {
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  isScopeExitError,
  ReturnError,
  SubshellExitError
} from "./errors";
import { expandWord } from "./expansion";
import { getErrorMessage } from "./helpers/errors";
import { checkFdLimit, failure, result } from "./helpers/result";
import {
  applyRedirections,
  preOpenOutputRedirects,
  processFdVariableRedirections
} from "./redirections";
import type { InterpreterContext } from "./types";

/**
 * Type for executeStatement callback
 */
export type ExecuteStatementFn = (stmt: StatementNode) => Promise<ExecResult>;

/**
 * Execute a subshell node (...).
 * Creates an isolated execution environment that doesn't affect the parent.
 */
export async function executeSubshell(
  ctx: InterpreterContext,
  node: SubshellNode,
  stdin: string,
  executeStatement: ExecuteStatementFn
): Promise<ExecResult> {
  // Pre-open output redirects to truncate files BEFORE executing body
  // This matches bash behavior where redirect files are opened before
  // any command substitutions in the subshell body are evaluated
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }

  const savedEnv = new Map(ctx.state.env);
  const savedCwd = ctx.state.cwd;
  // Save options so subshell changes (like set -e) don't affect parent
  const savedOptions = { ...ctx.state.options };

  // Save functions so subshell definitions don't leak to parent
  // This is critical for proper subshell isolation - in real bash, function
  // definitions inside (...) are isolated and don't affect the parent shell
  // Note: Aliases are stored in env with BASH_ALIAS_ prefix, so they're
  // already isolated via savedEnv
  const savedFunctions = new Map(ctx.state.functions);

  // Save local variable scoping state for subshell isolation
  // Subshell gets a copy of these, but changes don't affect parent
  const savedLocalScopes = ctx.state.localScopes;
  const savedLocalVarStack = ctx.state.localVarStack;
  const savedLocalVarDepth = ctx.state.localVarDepth;
  const savedFullyUnsetLocals = ctx.state.fullyUnsetLocals;

  // Deep copy the local scoping structures for the subshell
  ctx.state.localScopes = savedLocalScopes.map((scope) => new Map(scope));
  if (savedLocalVarStack) {
    ctx.state.localVarStack = new Map();
    for (const [name, stack] of savedLocalVarStack.entries()) {
      ctx.state.localVarStack.set(
        name,
        stack.map((entry) => ({ ...entry }))
      );
    }
  }
  if (savedLocalVarDepth) {
    ctx.state.localVarDepth = new Map(savedLocalVarDepth);
  }
  if (savedFullyUnsetLocals) {
    ctx.state.fullyUnsetLocals = new Map(savedFullyUnsetLocals);
  }

  // Reset loopDepth in subshell - break/continue should not affect parent loops
  const savedLoopDepth = ctx.state.loopDepth;
  // Track if parent has loop context - break/continue in subshell should exit subshell
  const savedParentHasLoopContext = ctx.state.parentHasLoopContext;
  ctx.state.parentHasLoopContext = savedLoopDepth > 0;
  ctx.state.loopDepth = 0;

  // Save $_ (last argument) - subshell execution should not affect parent's $_
  const savedLastArg = ctx.state.lastArg;

  // Subshells get a new BASHPID (unlike $$ which stays the same)
  const savedBashPid = ctx.state.bashPid;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;

  // Save any existing groupStdin and set new one from pipeline
  const savedGroupStdin = ctx.state.groupStdin;
  if (stdin) {
    ctx.state.groupStdin = stdin;
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  const restore = (): void => {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.options = savedOptions;
    ctx.state.functions = savedFunctions;
    ctx.state.localScopes = savedLocalScopes;
    ctx.state.localVarStack = savedLocalVarStack;
    ctx.state.localVarDepth = savedLocalVarDepth;
    ctx.state.fullyUnsetLocals = savedFullyUnsetLocals;
    ctx.state.loopDepth = savedLoopDepth;
    ctx.state.parentHasLoopContext = savedParentHasLoopContext;
    ctx.state.groupStdin = savedGroupStdin;
    ctx.state.bashPid = savedBashPid;
    ctx.state.lastArg = savedLastArg;
  };

  try {
    for (const stmt of node.body) {
      const res = await executeStatement(stmt);
      stdout += res.stdout;
      stderr += res.stderr;
      exitCode = res.exitCode;
    }
  } catch (error) {
    restore();
    // ExecutionLimitError must always propagate - these are safety limits
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    // SubshellExitError means break/continue was called when parent had loop context
    // This exits the subshell cleanly with exit code 0
    if (error instanceof SubshellExitError) {
      stdout += error.stdout;
      stderr += error.stderr;
      // Apply output redirections before returning
      const bodyResult = result(stdout, stderr, 0);
      return applyRedirections(ctx, bodyResult, node.redirections);
    }
    // BreakError/ContinueError should NOT propagate out of subshell
    // They only affect loops within the subshell
    if (error instanceof BreakError || error instanceof ContinueError) {
      stdout += error.stdout;
      stderr += error.stderr;
      // Apply output redirections before returning
      const bodyResult = result(stdout, stderr, 0);
      return applyRedirections(ctx, bodyResult, node.redirections);
    }
    // ExitError in subshell should NOT propagate - just return the exit code
    // (subshells are like separate processes)
    if (error instanceof ExitError) {
      stdout += error.stdout;
      stderr += error.stderr;
      // Apply output redirections before returning
      const bodyResult = result(stdout, stderr, error.exitCode);
      return applyRedirections(ctx, bodyResult, node.redirections);
    }
    // ReturnError in subshell (e.g., f() ( return 42; )) should also just exit
    // with the given code, since subshells are like separate processes
    if (error instanceof ReturnError) {
      stdout += error.stdout;
      stderr += error.stderr;
      // Apply output redirections before returning
      const bodyResult = result(stdout, stderr, error.exitCode);
      return applyRedirections(ctx, bodyResult, node.redirections);
    }
    if (error instanceof ErrexitError) {
      // Apply output redirections before propagating
      const bodyResult = result(
        stdout + error.stdout,
        stderr + error.stderr,
        error.exitCode
      );
      return applyRedirections(ctx, bodyResult, node.redirections);
    }
    // Apply output redirections before returning
    const bodyResult = result(
      stdout,
      `${stderr}${getErrorMessage(error)}\n`,
      1
    );
    return applyRedirections(ctx, bodyResult, node.redirections);
  }

  restore();

  // Apply output redirections
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}

/**
 * Execute a group node { ...; }.
 * Runs commands in the current execution environment.
 */
export async function executeGroup(
  ctx: InterpreterContext,
  node: GroupNode,
  stdin: string,
  executeStatement: ExecuteStatementFn
): Promise<ExecResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  // Process FD variable redirections ({varname}>file syntax)
  const fdVarError = await processFdVariableRedirections(
    ctx,
    node.redirections
  );
  if (fdVarError) {
    return fdVarError;
  }

  // Process heredoc and input redirections to get stdin content
  let effectiveStdin = stdin;
  for (const redir of node.redirections) {
    if (
      (redir.operator === "<<" || redir.operator === "<<-") &&
      redir.target.type === "HereDoc"
    ) {
      const hereDoc = redir.target as HereDocNode;
      let content = await expandWord(ctx, hereDoc.content);
      if (hereDoc.stripTabs) {
        content = content
          .split("\n")
          .map((line) => line.replace(/^\t+/, ""))
          .join("\n");
      }
      // If this is a non-standard fd (not 0), store in fileDescriptors for -u option
      const fd = redir.fd ?? 0;
      if (fd !== 0) {
        if (!ctx.state.fileDescriptors) {
          ctx.state.fileDescriptors = new Map();
        }
        checkFdLimit(ctx);
        ctx.state.fileDescriptors.set(fd, content);
      } else {
        effectiveStdin = content;
      }
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      effectiveStdin = `${await expandWord(ctx, redir.target as WordNode)}\n`;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      try {
        const target = await expandWord(ctx, redir.target as WordNode);
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        effectiveStdin = await ctx.fs.readFile(filePath);
      } catch {
        const target = await expandWord(ctx, redir.target as WordNode);
        return result("", `bash: ${target}: No such file or directory\n`, 1);
      }
    }
  }

  // Save any existing groupStdin and set new one from pipeline
  const savedGroupStdin = ctx.state.groupStdin;
  if (effectiveStdin) {
    ctx.state.groupStdin = effectiveStdin;
  }

  try {
    for (const stmt of node.body) {
      const res = await executeStatement(stmt);
      stdout += res.stdout;
      stderr += res.stderr;
      exitCode = res.exitCode;
    }
  } catch (error) {
    // Restore groupStdin before handling error
    ctx.state.groupStdin = savedGroupStdin;
    // ExecutionLimitError must always propagate - these are safety limits
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    if (
      isScopeExitError(error) ||
      error instanceof ErrexitError ||
      error instanceof ExitError
    ) {
      error.prependOutput(stdout, stderr);
      throw error;
    }
    return result(stdout, `${stderr}${getErrorMessage(error)}\n`, 1);
  }

  // Restore groupStdin
  ctx.state.groupStdin = savedGroupStdin;

  // Apply output redirections
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}

/**
 * Type for executeScript callback
 */
export type ExecuteScriptFn = (node: ScriptNode) => Promise<ExecResult>;

/**
 * Execute a user script file found in PATH.
 * This handles executable files that don't have registered command handlers.
 * The script runs in a subshell-like environment with its own positional parameters.
 */
export async function executeUserScript(
  ctx: InterpreterContext,
  scriptPath: string,
  args: string[],
  stdin: string,
  executeScript: ExecuteScriptFn
): Promise<ExecResult> {
  // Read the script content
  let content: string;
  try {
    content = await ctx.fs.readFile(scriptPath);
  } catch {
    return failure(`bash: ${scriptPath}: No such file or directory\n`, 127);
  }

  // Check for shebang and skip it if present (we'll execute as bash script)
  // Note: we don't actually support different interpreters, just bash
  if (content.startsWith("#!")) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline !== -1) {
      content = content.slice(firstNewline + 1);
    }
  }

  // Save current state for restoration after script execution
  const savedEnv = new Map(ctx.state.env);
  const savedCwd = ctx.state.cwd;
  const savedOptions = { ...ctx.state.options };
  const savedLoopDepth = ctx.state.loopDepth;
  const savedParentHasLoopContext = ctx.state.parentHasLoopContext;
  const savedLastArg = ctx.state.lastArg;
  const savedBashPid = ctx.state.bashPid;
  const savedGroupStdin = ctx.state.groupStdin;
  const savedSource = ctx.state.currentSource;

  // Set up subshell-like environment
  ctx.state.parentHasLoopContext = savedLoopDepth > 0;
  ctx.state.loopDepth = 0;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;
  if (stdin) {
    ctx.state.groupStdin = stdin;
  }
  ctx.state.currentSource = scriptPath;

  // Set positional parameters ($1, $2, etc.) from args
  // $0 should be the script path
  ctx.state.env.set("0", scriptPath);
  ctx.state.env.set("#", String(args.length));
  ctx.state.env.set("@", args.join(" "));
  ctx.state.env.set("*", args.join(" "));
  for (let i = 0; i < args.length && i < 9; i++) {
    ctx.state.env.set(String(i + 1), args[i]);
  }
  // Clear any remaining positional parameters
  for (let i = args.length + 1; i <= 9; i++) {
    ctx.state.env.delete(String(i));
  }

  const cleanup = (): void => {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.options = savedOptions;
    ctx.state.loopDepth = savedLoopDepth;
    ctx.state.parentHasLoopContext = savedParentHasLoopContext;
    ctx.state.lastArg = savedLastArg;
    ctx.state.bashPid = savedBashPid;
    ctx.state.groupStdin = savedGroupStdin;
    ctx.state.currentSource = savedSource;
  };

  try {
    const parser = new Parser();
    const ast = parser.parse(content);
    const execResult = await executeScript(ast);
    cleanup();
    return execResult;
  } catch (error) {
    cleanup();

    // ExitError propagates up (but with output from this script)
    if (error instanceof ExitError) {
      throw error;
    }

    // ExecutionLimitError must always propagate
    if (error instanceof ExecutionLimitError) {
      throw error;
    }

    // Handle parse errors
    if ((error as ParseException).name === "ParseException") {
      return failure(`bash: ${scriptPath}: ${(error as Error).message}\n`);
    }

    throw error;
  }
}
