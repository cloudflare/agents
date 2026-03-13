/**
 * Interpreter - AST Execution Engine
 *
 * Main interpreter class that executes bash AST nodes.
 * Delegates to specialized modules for:
 * - Word expansion (expansion.ts)
 * - Arithmetic evaluation (arithmetic.ts)
 * - Conditional evaluation (conditionals.ts)
 * - Built-in commands (builtins.ts)
 * - Redirections (redirections.ts)
 */

import type {
  ArithmeticCommandNode,
  CommandNode,
  ConditionalCommandNode,
  GroupNode,
  HereDocNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  SubshellNode,
  WordNode
} from "../ast/types";
import type { IFileSystem } from "../fs/interface";
import { mapToRecord } from "../helpers/env";
import type { ExecutionLimits } from "../limits";
import type { SecureFetch } from "../network/index";
import { ParseException } from "../parser/types";
import type { CommandRegistry, ExecResult, TraceCallback } from "../types";
import { expandAlias as expandAliasHelper } from "./alias-expansion";
import { evaluateArithmetic } from "./arithmetic";
import {
  expandLocalArrayAssignment as expandLocalArrayAssignmentHelper,
  expandScalarAssignmentArg as expandScalarAssignmentArgHelper
} from "./assignment-expansion";
import {
  type BuiltinDispatchContext,
  dispatchBuiltin,
  executeExternalCommand
} from "./builtin-dispatch";
import { findCommandInPath as findCommandInPathHelper } from "./command-resolution";
import { evaluateConditional } from "./conditionals";
import {
  executeCase,
  executeCStyleFor,
  executeFor,
  executeIf,
  executeUntil,
  executeWhile
} from "./control-flow";
import {
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionAbortedError,
  ExecutionLimitError,
  ExitError,
  GlobError,
  NounsetError,
  PosixFatalError,
  ReturnError
} from "./errors";
import { expandWord, expandWordWithGlob } from "./expansion";
import { executeFunctionDef } from "./functions";
import {
  checkFdLimit,
  failure,
  OK,
  result,
  testResult,
  throwExecutionLimit
} from "./helpers/result";
import { isPosixSpecialBuiltin } from "./helpers/shell-constants";
import { isWordLiteralMatch, parseRwFdContent } from "./helpers/word-matching";
import { traceSimpleCommand } from "./helpers/xtrace";
import { executePipeline as executePipelineHelper } from "./pipeline-execution";
import {
  applyRedirections,
  preOpenOutputRedirects,
  processFdVariableRedirections
} from "./redirections";
import { processAssignments } from "./simple-command-assignments";
import {
  executeGroup as executeGroupHelper,
  executeSubshell as executeSubshellHelper,
  executeUserScript as executeUserScriptHelper
} from "./subshell-group";
import type { InterpreterContext, InterpreterState } from "./types";

export type { InterpreterContext, InterpreterState } from "./types";

export interface InterpreterOptions {
  fs: IFileSystem;
  commands: CommandRegistry;
  limits: Required<ExecutionLimits>;
  exec: (
    script: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      replaceEnv?: boolean;
      signal?: AbortSignal;
      args?: string[];
    }
  ) => Promise<ExecResult>;
  /** Optional secure fetch function for network-enabled commands */
  fetch?: SecureFetch;
  /** Optional sleep function for testing with mock clocks */
  sleep?: (ms: number) => Promise<void>;
  /** Optional trace callback for performance profiling */
  trace?: TraceCallback;
}

export class Interpreter {
  private ctx: InterpreterContext;

  constructor(options: InterpreterOptions, state: InterpreterState) {
    this.ctx = {
      state,
      fs: options.fs,
      commands: options.commands,
      limits: options.limits,
      execFn: options.exec,
      executeScript: this.executeScript.bind(this),
      executeStatement: this.executeStatement.bind(this),
      executeCommand: this.executeCommand.bind(this),
      fetch: options.fetch,
      sleep: options.sleep,
      trace: options.trace
    };
  }

  /**
   * Build environment record containing only exported variables.
   * In bash, only exported variables are passed to child processes.
   * This includes both permanently exported variables (via export/declare -x)
   * and temporarily exported variables (prefix assignments like FOO=bar cmd).
   */
  private buildExportedEnv(): Record<string, string> {
    const exportedVars = this.ctx.state.exportedVars;
    const tempExportedVars = this.ctx.state.tempExportedVars;

    // Combine both exported and temp exported vars
    const allExported = new Set<string>();
    if (exportedVars) {
      for (const name of exportedVars) {
        allExported.add(name);
      }
    }
    if (tempExportedVars) {
      for (const name of tempExportedVars) {
        allExported.add(name);
      }
    }

    if (allExported.size === 0) {
      // No exported vars - return empty env
      // This matches bash behavior where variables must be exported to be visible to children
      return Object.create(null);
    }

    // Use null-prototype to prevent prototype pollution via user-controlled variable names
    const env: Record<string, string> = Object.create(null);
    for (const name of allExported) {
      const value = this.ctx.state.env.get(name);
      if (value !== undefined) {
        env[name] = value;
      }
    }
    return env;
  }

  async executeScript(node: ScriptNode): Promise<ExecResult> {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const maxOutputSize = this.ctx.limits.maxOutputSize;

    const appendOutput = (nextStdout: string, nextStderr: string): void => {
      if (
        stdout.length + stderr.length + nextStdout.length + nextStderr.length >
        maxOutputSize
      ) {
        throwExecutionLimit(
          `total output size exceeded (>${maxOutputSize} bytes), increase executionLimits.maxOutputSize`,
          "output_size"
        );
      }
      stdout += nextStdout;
      stderr += nextStderr;
    };

    for (const statement of node.statements) {
      try {
        const result = await this.executeStatement(statement);
        appendOutput(result.stdout, result.stderr);
        exitCode = result.exitCode;
        this.ctx.state.lastExitCode = exitCode;
        this.ctx.state.env.set("?", String(exitCode));
      } catch (error) {
        // ExitError always propagates up to terminate the script
        // This allows 'eval exit 42' and 'source exit.sh' to exit properly
        if (error instanceof ExitError) {
          error.prependOutput(stdout, stderr);
          throw error;
        }
        // PosixFatalError terminates the script in POSIX mode
        // POSIX 2.8.1: special builtins cause shell to exit on error
        if (error instanceof PosixFatalError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env)
          };
        }
        // ExecutionLimitError must always propagate - these are safety limits
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        if (error instanceof ErrexitError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env)
          };
        }
        if (error instanceof NounsetError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env)
          };
        }
        if (error instanceof BadSubstitutionError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env)
          };
        }
        // ArithmeticError in expansion (e.g., echo $((42x))) - the command fails
        // but the script continues execution. This matches bash behavior.
        if (error instanceof ArithmeticError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          // Continue to next statement instead of terminating script
          continue;
        }
        // BraceExpansionError for invalid ranges (e.g., {z..A} mixed case) - the command fails
        // but the script continues execution. This matches bash behavior.
        if (error instanceof BraceExpansionError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          // Continue to next statement instead of terminating script
          continue;
        }
        // Handle break/continue errors
        if (error instanceof BreakError || error instanceof ContinueError) {
          // If we're inside a loop, propagate the error up (for eval/source inside loops)
          if (this.ctx.state.loopDepth > 0) {
            error.prependOutput(stdout, stderr);
            throw error;
          }
          // Outside loops (level exceeded loop depth), silently continue with next statement
          appendOutput(error.stdout, error.stderr);
          continue;
        }
        // Handle return - prepend accumulated output before propagating
        if (error instanceof ReturnError) {
          error.prependOutput(stdout, stderr);
          throw error;
        }
        throw error;
      }
    }

    return {
      stdout,
      stderr,
      exitCode,
      env: mapToRecord(this.ctx.state.env)
    };
  }

  /**
   * Execute a user script file found in PATH.
   */
  private async executeUserScript(
    scriptPath: string,
    args: string[],
    stdin = ""
  ): Promise<ExecResult> {
    return executeUserScriptHelper(this.ctx, scriptPath, args, stdin, (ast) =>
      this.executeScript(ast)
    );
  }

  private async executeStatement(node: StatementNode): Promise<ExecResult> {
    // Check for abort signal (cooperative cancellation by timeout command)
    if (this.ctx.state.signal?.aborted) {
      throw new ExecutionAbortedError();
    }

    this.ctx.state.commandCount++;
    if (this.ctx.state.commandCount > this.ctx.limits.maxCommandCount) {
      throwExecutionLimit(
        `too many commands executed (>${this.ctx.limits.maxCommandCount}), increase executionLimits.maxCommandCount`,
        "commands"
      );
    }

    // Check for deferred syntax error. This is triggered when execution reaches
    // a statement that has a syntax error (like standalone `}`), but the error
    // was deferred to support bash's incremental parsing behavior.
    if (node.deferredError) {
      throw new ParseException(node.deferredError.message, node.line ?? 1, 1);
    }

    // noexec mode (set -n): parse commands but do not execute them
    // This is used for syntax checking scripts without actually running them
    if (this.ctx.state.options.noexec) {
      return OK;
    }

    // Reset errexitSafe at the start of each statement
    // It will be set by inner compound command executions if needed
    this.ctx.state.errexitSafe = false;

    let stdout = "";
    let stderr = "";

    // verbose mode (set -v): print unevaluated source before execution
    // Don't print verbose output inside command substitutions (suppressVerbose flag)
    if (
      this.ctx.state.options.verbose &&
      !this.ctx.state.suppressVerbose &&
      node.sourceText
    ) {
      stderr += `${node.sourceText}\n`;
    }
    let exitCode = 0;
    let lastExecutedIndex = -1;
    let lastPipelineNegated = false;

    for (let i = 0; i < node.pipelines.length; i++) {
      const pipeline = node.pipelines[i];
      const operator = i > 0 ? node.operators[i - 1] : null;

      if (operator === "&&" && exitCode !== 0) continue;
      if (operator === "||" && exitCode === 0) continue;

      const result = await this.executePipeline(pipeline);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
      lastExecutedIndex = i;
      lastPipelineNegated = pipeline.negated;

      // Update $? after each pipeline so it's available for subsequent commands
      this.ctx.state.lastExitCode = exitCode;
      this.ctx.state.env.set("?", String(exitCode));
    }

    // Track whether this exit code is "safe" for errexit purposes
    // (i.e., the failure was from a && or || chain where the final command wasn't reached,
    // OR the failure came from a compound command where the inner statement was errexit-safe)
    const wasShortCircuited = lastExecutedIndex < node.pipelines.length - 1;
    // Preserve errexitSafe if it was set by an inner compound command
    const innerWasSafe = this.ctx.state.errexitSafe;
    this.ctx.state.errexitSafe =
      wasShortCircuited || lastPipelineNegated || innerWasSafe;

    // Check errexit (set -e): exit if command failed
    // Exceptions:
    // - Command was in a && or || list and wasn't the final command (short-circuit)
    // - Command was negated with !
    // - Command is part of a condition in if/while/until
    // - Exit code came from a compound command where inner execution was errexit-safe
    if (
      this.ctx.state.options.errexit &&
      exitCode !== 0 &&
      lastExecutedIndex === node.pipelines.length - 1 &&
      !lastPipelineNegated &&
      !this.ctx.state.inCondition &&
      !innerWasSafe
    ) {
      throw new ErrexitError(exitCode, stdout, stderr);
    }

    return result(stdout, stderr, exitCode);
  }

  private async executePipeline(node: PipelineNode): Promise<ExecResult> {
    return executePipelineHelper(this.ctx, node, (cmd, stdin) =>
      this.executeCommand(cmd, stdin)
    );
  }

  private async executeCommand(
    node: CommandNode,
    stdin: string
  ): Promise<ExecResult> {
    switch (node.type) {
      case "SimpleCommand":
        return this.executeSimpleCommand(node, stdin);
      case "If":
        return executeIf(this.ctx, node);
      case "For":
        return executeFor(this.ctx, node);
      case "CStyleFor":
        return executeCStyleFor(this.ctx, node);
      case "While":
        return executeWhile(this.ctx, node, stdin);
      case "Until":
        return executeUntil(this.ctx, node);
      case "Case":
        return executeCase(this.ctx, node);
      case "Subshell":
        return this.executeSubshell(node, stdin);
      case "Group":
        return this.executeGroup(node, stdin);
      case "FunctionDef":
        return executeFunctionDef(this.ctx, node);
      case "ArithmeticCommand":
        return this.executeArithmeticCommand(node);
      case "ConditionalCommand":
        return this.executeConditionalCommand(node);
      default:
        return OK;
    }
  }

  private async executeSimpleCommand(
    node: SimpleCommandNode,
    stdin: string
  ): Promise<ExecResult> {
    try {
      return await this.executeSimpleCommandInner(node, stdin);
    } catch (error) {
      if (error instanceof GlobError) {
        // GlobError from failglob should return exit code 1 with error message
        return failure(error.stderr);
      }
      // ArithmeticError in expansion (e.g., echo $((42x))) should terminate the script
      // Let the error propagate - it will be caught by the top-level error handler
      throw error;
    }
  }

  private async executeSimpleCommandInner(
    node: SimpleCommandNode,
    stdin: string
  ): Promise<ExecResult> {
    // Update currentLine for $LINENO
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    // Alias expansion: if expand_aliases is enabled and the command name is
    // a literal unquoted word that matches an alias, substitute it.
    // Keep expanding until no more alias expansion occurs (handles recursive aliases).
    // The aliasExpansionStack persists across iterations to prevent infinite loops.
    if (this.ctx.state.shoptOptions.expand_aliases && node.name) {
      let currentNode = node;
      let maxExpansions = 100; // Safety limit
      while (maxExpansions > 0) {
        const expandedNode = this.expandAlias(currentNode);
        if (expandedNode === currentNode) {
          break; // No expansion occurred
        }
        currentNode = expandedNode;
        maxExpansions--;
      }
      // Clear the alias expansion stack after all expansions are done
      this.aliasExpansionStack.clear();
      // Continue with the fully expanded node
      if (currentNode !== node) {
        node = currentNode;
      }
    }

    // Clear expansion stderr at the start
    this.ctx.state.expansionStderr = "";

    // Process all assignments (array, subscript, and scalar)
    const assignmentResult = await processAssignments(this.ctx, node);
    if (assignmentResult.error) {
      return assignmentResult.error;
    }
    const tempAssignments = assignmentResult.tempAssignments;
    const xtraceAssignmentOutput = assignmentResult.xtraceOutput;

    if (!node.name) {
      // No command name - could be assignment-only or redirect-only (bare redirects)
      // e.g., "x=5" (assignment-only) or "> file" (bare redirect to create empty file)

      // Handle bare redirections (no command, just redirects like "> file")
      // In bash, this creates/truncates the file and returns success
      if (node.redirections.length > 0) {
        // Process the redirects - this creates/truncates files as needed
        const redirectError = await preOpenOutputRedirects(
          this.ctx,
          node.redirections
        );
        if (redirectError) {
          return redirectError;
        }
        // Apply redirections to empty result (for append, read redirects, etc.)
        const baseResult = result("", xtraceAssignmentOutput, 0);
        return applyRedirections(this.ctx, baseResult, node.redirections);
      }

      // Assignment-only command: preserve the exit code from command substitution
      // e.g., x=$(false) should set $? to 1, not 0
      // Also clear $_ - bash clears it for bare assignments
      this.ctx.state.lastArg = "";
      // Include any stderr from command substitutions (e.g., FOO=$(echo foo 1>&2))
      const stderrOutput =
        (this.ctx.state.expansionStderr || "") + xtraceAssignmentOutput;
      this.ctx.state.expansionStderr = "";
      return result("", stderrOutput, this.ctx.state.lastExitCode);
    }

    // Mark prefix assignment variables as temporarily exported for this command
    // In bash, FOO=bar cmd makes FOO visible in cmd's environment
    // EXCEPTION: For assignment builtins (readonly, declare, local, export, typeset),
    // temp bindings should NOT be exported to command substitutions in the arguments.
    // e.g., `FOO=foo readonly v=$(printenv.py FOO)` - the $(printenv.py FOO) should NOT see FOO.
    // This is because assignment builtins don't actually run as external commands that receive
    // an exported environment - they process their arguments in the current shell context.
    const isLiteralAssignmentBuiltinForExport =
      node.name &&
      isWordLiteralMatch(node.name, [
        "local",
        "declare",
        "typeset",
        "export",
        "readonly"
      ]);
    const tempExportedVars = Array.from(tempAssignments.keys());
    if (tempExportedVars.length > 0 && !isLiteralAssignmentBuiltinForExport) {
      this.ctx.state.tempExportedVars =
        this.ctx.state.tempExportedVars || new Set();
      for (const name of tempExportedVars) {
        this.ctx.state.tempExportedVars.add(name);
      }
    }

    // Process FD variable redirections ({varname}>file syntax)
    // This allocates FDs and sets variables before command execution
    const fdVarError = await processFdVariableRedirections(
      this.ctx,
      node.redirections
    );
    if (fdVarError) {
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
      return fdVarError;
    }

    // Track source FD for stdin from read-write file descriptors
    // This allows the read builtin to update the FD's position after reading
    let stdinSourceFd = -1;

    for (const redir of node.redirections) {
      if (
        (redir.operator === "<<" || redir.operator === "<<-") &&
        redir.target.type === "HereDoc"
      ) {
        const hereDoc = redir.target as HereDocNode;
        let content = await expandWord(this.ctx, hereDoc.content);
        // <<- strips leading tabs from each line
        if (hereDoc.stripTabs) {
          content = content
            .split("\n")
            .map((line) => line.replace(/^\t+/, ""))
            .join("\n");
        }
        // If this is a non-standard fd (not 0), store in fileDescriptors for -u option
        const fd = redir.fd ?? 0;
        if (fd !== 0) {
          if (!this.ctx.state.fileDescriptors) {
            this.ctx.state.fileDescriptors = new Map();
          }
          checkFdLimit(this.ctx);
          this.ctx.state.fileDescriptors.set(fd, content);
        } else {
          stdin = content;
        }
        continue;
      }

      if (redir.operator === "<<<" && redir.target.type === "Word") {
        stdin = `${await expandWord(this.ctx, redir.target as WordNode)}\n`;
        continue;
      }

      if (redir.operator === "<" && redir.target.type === "Word") {
        try {
          const target = await expandWord(this.ctx, redir.target as WordNode);
          const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
          stdin = await this.ctx.fs.readFile(filePath);
        } catch {
          const target = await expandWord(this.ctx, redir.target as WordNode);
          for (const [name, value] of tempAssignments) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value);
          }
          return failure(`bash: ${target}: No such file or directory\n`);
        }
      }

      // Handle <& input redirection from file descriptor
      if (redir.operator === "<&" && redir.target.type === "Word") {
        const target = await expandWord(this.ctx, redir.target as WordNode);
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd) && this.ctx.state.fileDescriptors) {
          const fdContent = this.ctx.state.fileDescriptors.get(sourceFd);
          if (fdContent !== undefined) {
            // Handle different FD content formats
            if (fdContent.startsWith("__rw__:")) {
              // Read/write mode: format is __rw__:pathLength:path:position:content
              const parsed = parseRwFdContent(fdContent);
              if (parsed) {
                // Return content starting from current position
                stdin = parsed.content.slice(parsed.position);
                stdinSourceFd = sourceFd;
              }
            } else if (
              fdContent.startsWith("__file__:") ||
              fdContent.startsWith("__file_append__:")
            ) {
              // These are output-only, can't read from them
            } else {
              // Plain content (from exec N< file or here-docs)
              stdin = fdContent;
            }
          }
        }
      }
    }

    const commandName = await expandWord(this.ctx, node.name);

    const args: string[] = [];
    const quotedArgs: boolean[] = [];

    // Handle local/declare/export/readonly arguments specially:
    // - For array assignments like `local a=(1 "2 3")`, preserve quote structure
    // - For scalar assignments like `local foo=$bar`, DON'T glob expand the value
    // This matches bash behavior where assignment values aren't subject to word splitting/globbing
    //
    // IMPORTANT: This special handling only applies when the command is a LITERAL keyword,
    // not when it's determined via variable expansion. For example:
    // - `export var=$x` -> no word splitting (literal export keyword)
    // - `e=export; $e var=$x` -> word splitting DOES occur (export via variable)
    //
    // This is because bash determines at parse time whether the command is an assignment builtin.
    const isLiteralAssignmentBuiltin =
      isWordLiteralMatch(node.name, [
        "local",
        "declare",
        "typeset",
        "export",
        "readonly"
      ]) &&
      (commandName === "local" ||
        commandName === "declare" ||
        commandName === "typeset" ||
        commandName === "export" ||
        commandName === "readonly");

    if (isLiteralAssignmentBuiltin) {
      for (const arg of node.args) {
        const arrayAssignResult = await expandLocalArrayAssignmentHelper(
          this.ctx,
          arg
        );
        if (arrayAssignResult) {
          args.push(arrayAssignResult);
          quotedArgs.push(true);
        } else {
          // Check if this looks like a scalar assignment (name=value)
          // For assignments, we should NOT glob-expand the value part
          const scalarAssignResult = await expandScalarAssignmentArgHelper(
            this.ctx,
            arg
          );
          if (scalarAssignResult !== null) {
            args.push(scalarAssignResult);
            quotedArgs.push(true);
          } else {
            // Not an assignment - use normal glob expansion
            const expanded = await expandWordWithGlob(this.ctx, arg);
            for (const value of expanded.values) {
              args.push(value);
              quotedArgs.push(expanded.quoted);
            }
          }
        }
      }
    } else {
      // Expand args even if command name is empty (they may have side effects)
      for (const arg of node.args) {
        const expanded = await expandWordWithGlob(this.ctx, arg);
        for (const value of expanded.values) {
          args.push(value);
          quotedArgs.push(expanded.quoted);
        }
      }
    }

    // Handle empty command name specially
    // If the command word contains ONLY command substitutions/expansions and expands
    // to empty, word-splitting removes the empty result. If there are args, the first
    // arg becomes the command name. This matches bash behavior:
    // - x=''; $x is a no-op (empty, no args)
    // - x=''; $x Y runs command Y (empty command name, Y becomes command)
    // - `true` X runs command X (since `true` outputs nothing)
    // However, a literal empty string (like '') is "command not found".
    if (!commandName) {
      const isOnlyExpansions = node.name.parts.every(
        (p) =>
          p.type === "CommandSubstitution" ||
          p.type === "ParameterExpansion" ||
          p.type === "ArithmeticExpansion"
      );
      if (isOnlyExpansions) {
        // Empty result from variable/command substitution - word split removes it
        // If there are args, the first arg becomes the command name
        if (args.length > 0) {
          const newCommandName = args.shift() as string;
          quotedArgs.shift();
          return await this.runCommand(
            newCommandName,
            args,
            quotedArgs,
            stdin,
            false,
            false,
            stdinSourceFd
          );
        }
        // No args - treat as no-op (status 0)
        // Preserve lastExitCode for command subs like $(exit 42)
        return result("", "", this.ctx.state.lastExitCode);
      }
      // Literal empty command name - command not found
      return failure("bash: : command not found\n", 127);
    }

    // Special handling for 'exec' with only redirections (no command to run)
    // In this case, the redirections apply persistently to the shell
    if (commandName === "exec" && (args.length === 0 || args[0] === "--")) {
      // Process persistent FD redirections
      // Note: {var}>file redirections are already handled by processFdVariableRedirections
      // which sets up the FD mapping persistently. We only need to handle explicit fd redirections here.
      for (const redir of node.redirections) {
        if (redir.target.type === "HereDoc") continue;

        // Skip FD variable redirections - already handled by processFdVariableRedirections
        if (redir.fdVariable) continue;

        const target = await expandWord(this.ctx, redir.target as WordNode);
        const fd =
          redir.fd ??
          (redir.operator === "<" || redir.operator === "<>" ? 0 : 1);

        if (!this.ctx.state.fileDescriptors) {
          this.ctx.state.fileDescriptors = new Map();
        }

        switch (redir.operator) {
          case ">":
          case ">|": {
            // Open file for writing (truncate)
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target
            );
            await this.ctx.fs.writeFile(filePath, "", "utf8"); // truncate
            checkFdLimit(this.ctx);
            this.ctx.state.fileDescriptors.set(fd, `__file__:${filePath}`);
            break;
          }
          case ">>": {
            // Open file for appending
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target
            );
            checkFdLimit(this.ctx);
            this.ctx.state.fileDescriptors.set(
              fd,
              `__file_append__:${filePath}`
            );
            break;
          }
          case "<": {
            // Open file for reading - store its content
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target
            );
            try {
              const content = await this.ctx.fs.readFile(filePath);
              checkFdLimit(this.ctx);
              this.ctx.state.fileDescriptors.set(fd, content);
            } catch {
              return failure(`bash: ${target}: No such file or directory\n`);
            }
            break;
          }
          case "<>": {
            // Open file for read/write
            // Format: __rw__:pathLength:path:position:content
            // pathLength allows parsing paths with colons
            // position tracks current file offset for read/write
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target
            );
            try {
              const content = await this.ctx.fs.readFile(filePath);
              checkFdLimit(this.ctx);
              this.ctx.state.fileDescriptors.set(
                fd,
                `__rw__:${filePath.length}:${filePath}:0:${content}`
              );
            } catch {
              // File doesn't exist - create empty
              await this.ctx.fs.writeFile(filePath, "", "utf8");
              checkFdLimit(this.ctx);
              this.ctx.state.fileDescriptors.set(
                fd,
                `__rw__:${filePath.length}:${filePath}:0:`
              );
            }
            break;
          }
          case ">&": {
            // Duplicate output FD: N>&M means N now writes to same place as M
            // Move FD: N>&M- means duplicate M to N, then close M
            if (target === "-") {
              // Close the FD
              this.ctx.state.fileDescriptors.delete(fd);
            } else if (target.endsWith("-")) {
              // Move operation: N>&M- duplicates M to N then closes M
              // Net-neutral on FD count (set + delete), skip checkFdLimit
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                // First, duplicate: copy the FD content/info from source to target
                const sourceInfo = this.ctx.state.fileDescriptors.get(sourceFd);
                if (sourceInfo !== undefined) {
                  this.ctx.state.fileDescriptors.set(fd, sourceInfo);
                } else {
                  // Source FD might be 1 (stdout) or 2 (stderr) which aren't in fileDescriptors
                  // In that case, store as duplication marker
                  this.ctx.state.fileDescriptors.set(
                    fd,
                    `__dupout__:${sourceFd}`
                  );
                }
                // Then close the source FD
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                // Store FD duplication: fd N points to fd M
                checkFdLimit(this.ctx);
                this.ctx.state.fileDescriptors.set(
                  fd,
                  `__dupout__:${sourceFd}`
                );
              }
            }
            break;
          }
          case "<&": {
            // Duplicate input FD: N<&M means N now reads from same place as M
            // Move FD: N<&M- means duplicate M to N, then close M
            if (target === "-") {
              // Close the FD
              this.ctx.state.fileDescriptors.delete(fd);
            } else if (target.endsWith("-")) {
              // Move operation: N<&M- duplicates M to N then closes M
              // Net-neutral on FD count (set + delete), skip checkFdLimit
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                // First, duplicate: copy the FD content/info from source to target
                const sourceInfo = this.ctx.state.fileDescriptors.get(sourceFd);
                if (sourceInfo !== undefined) {
                  this.ctx.state.fileDescriptors.set(fd, sourceInfo);
                } else {
                  // Source FD might be 0 (stdin) which isn't in fileDescriptors
                  this.ctx.state.fileDescriptors.set(
                    fd,
                    `__dupin__:${sourceFd}`
                  );
                }
                // Then close the source FD
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                // Store FD duplication for input
                checkFdLimit(this.ctx);
                this.ctx.state.fileDescriptors.set(fd, `__dupin__:${sourceFd}`);
              }
            }
            break;
          }
        }
      }
      // In bash, "exec" with only redirections does NOT persist prefix assignments
      // This is the "special case of the special case" - unlike other special builtins
      // (like ":"), exec without a command restores temp assignments
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
      // Clear temp exported vars
      if (this.ctx.state.tempExportedVars) {
        for (const name of tempAssignments.keys()) {
          this.ctx.state.tempExportedVars.delete(name);
        }
      }
      return OK;
    }

    // Append extra args injected via exec({ args }) and consume them
    if (this.ctx.state.extraArgs) {
      args.push(...this.ctx.state.extraArgs);
      for (let i = 0; i < this.ctx.state.extraArgs.length; i++) {
        quotedArgs.push(true);
      }
      this.ctx.state.extraArgs = undefined;
    }

    // Generate xtrace output before running the command
    const xtraceOutput = await traceSimpleCommand(this.ctx, commandName, args);

    // Push tempEnvBindings onto the stack so unset can see them
    // This allows `unset v` to reveal the underlying global value when
    // v was set by a prefix assignment like `v=tempenv cmd`
    if (tempAssignments.size > 0) {
      this.ctx.state.tempEnvBindings = this.ctx.state.tempEnvBindings || [];
      this.ctx.state.tempEnvBindings.push(new Map(tempAssignments));
    }

    let cmdResult: ExecResult;
    let controlFlowError: BreakError | ContinueError | null = null;

    try {
      cmdResult = await this.runCommand(
        commandName,
        args,
        quotedArgs,
        stdin,
        false,
        false,
        stdinSourceFd
      );
    } catch (error) {
      // For break/continue, we still need to apply redirections before propagating
      // This handles cases like "break > file" where the file should be created
      if (error instanceof BreakError || error instanceof ContinueError) {
        controlFlowError = error;
        cmdResult = OK; // break/continue have exit status 0
      } else {
        throw error;
      }
    }

    // Prepend xtrace output and any assignment warnings to stderr
    const stderrPrefix = xtraceAssignmentOutput + xtraceOutput;
    if (stderrPrefix) {
      cmdResult = {
        ...cmdResult,
        stderr: stderrPrefix + cmdResult.stderr
      };
    }

    cmdResult = await applyRedirections(this.ctx, cmdResult, node.redirections);

    // If we caught a break/continue error, re-throw it after applying redirections
    if (controlFlowError) {
      throw controlFlowError;
    }

    // Update $_ to the last argument of this command (after expansion)
    // If no arguments, $_ is set to the command name
    // Special case: for declare/local/typeset with array assignments like "a=(1 2)",
    // bash sets $_ to just the variable name "a", not the full "a=(1 2)"
    if (args.length > 0) {
      let lastArg = args[args.length - 1];
      if (
        (commandName === "declare" ||
          commandName === "local" ||
          commandName === "typeset") &&
        /^[a-zA-Z_][a-zA-Z0-9_]*=\(/.test(lastArg)
      ) {
        // Extract just the variable name from array assignment
        const match = lastArg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\(/);
        if (match) {
          lastArg = match[1];
        }
      }
      this.ctx.state.lastArg = lastArg;
    } else {
      this.ctx.state.lastArg = commandName;
    }

    // In POSIX mode, prefix assignments persist after special builtins
    // e.g., `foo=bar :` leaves foo=bar in the environment
    // Exception: `unset` and `eval` - bash doesn't apply POSIX temp binding persistence
    // for these builtins when they modify the same variable as the temp binding
    // In non-POSIX mode (bash default), temp assignments are always restored
    const isPosixSpecialWithPersistence =
      isPosixSpecialBuiltin(commandName) &&
      commandName !== "unset" &&
      commandName !== "eval";
    const shouldRestoreTempAssignments =
      !this.ctx.state.options.posix || !isPosixSpecialWithPersistence;

    if (shouldRestoreTempAssignments) {
      for (const [name, value] of tempAssignments) {
        // Skip restoration if this variable was a local that was fully unset
        // This implements bash's behavior where unsetting all local cells
        // prevents the tempenv from being restored
        if (this.ctx.state.fullyUnsetLocals?.has(name)) {
          continue;
        }
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
    }

    // Clear temp exported vars after command execution
    if (this.ctx.state.tempExportedVars) {
      for (const name of tempAssignments.keys()) {
        this.ctx.state.tempExportedVars.delete(name);
      }
    }

    // Pop tempEnvBindings from the stack
    if (tempAssignments.size > 0 && this.ctx.state.tempEnvBindings) {
      this.ctx.state.tempEnvBindings.pop();
    }

    // Include any stderr from expansion errors
    if (this.ctx.state.expansionStderr) {
      cmdResult = {
        ...cmdResult,
        stderr: this.ctx.state.expansionStderr + cmdResult.stderr
      };
      this.ctx.state.expansionStderr = "";
    }

    return cmdResult;
  }

  private async runCommand(
    commandName: string,
    args: string[],
    quotedArgs: boolean[],
    stdin: string,
    skipFunctions = false,
    useDefaultPath = false,
    stdinSourceFd = -1
  ): Promise<ExecResult> {
    const dispatchCtx: BuiltinDispatchContext = {
      ctx: this.ctx,
      runCommand: (name, a, qa, s, sf, udp, ssf) =>
        this.runCommand(name, a, qa, s, sf, udp, ssf),
      buildExportedEnv: () => this.buildExportedEnv(),
      executeUserScript: (path, a, s) => this.executeUserScript(path, a, s)
    };

    // Try builtin dispatch first
    const builtinResult = await dispatchBuiltin(
      dispatchCtx,
      commandName,
      args,
      quotedArgs,
      stdin,
      skipFunctions,
      useDefaultPath,
      stdinSourceFd
    );

    if (builtinResult !== null) {
      return builtinResult;
    }

    // Handle external command
    return executeExternalCommand(
      dispatchCtx,
      commandName,
      args,
      stdin,
      useDefaultPath
    );
  }

  // Alias expansion state
  private aliasExpansionStack: Set<string> = new Set();

  private expandAlias(node: SimpleCommandNode): SimpleCommandNode {
    return expandAliasHelper(this.ctx.state, node, this.aliasExpansionStack);
  }

  async findCommandInPath(commandName: string): Promise<string[]> {
    return findCommandInPathHelper(this.ctx, commandName);
  }

  private async executeSubshell(
    node: SubshellNode,
    stdin = ""
  ): Promise<ExecResult> {
    return executeSubshellHelper(this.ctx, node, stdin, (stmt) =>
      this.executeStatement(stmt)
    );
  }

  private async executeGroup(node: GroupNode, stdin = ""): Promise<ExecResult> {
    return executeGroupHelper(this.ctx, node, stdin, (stmt) =>
      this.executeStatement(stmt)
    );
  }

  private async executeArithmeticCommand(
    node: ArithmeticCommandNode
  ): Promise<ExecResult> {
    // Update currentLine for $LINENO
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    // Pre-open output redirects to truncate files BEFORE evaluating expression
    // This matches bash behavior where redirect files are opened before
    // any command substitutions in the arithmetic expression are evaluated
    const preOpenError = await preOpenOutputRedirects(
      this.ctx,
      node.redirections
    );
    if (preOpenError) {
      return preOpenError;
    }

    try {
      const arithResult = await evaluateArithmetic(
        this.ctx,
        node.expression.expression
      );
      // Apply output redirections
      let bodyResult = testResult(arithResult !== 0);
      // Include any stderr from expansion (e.g., command substitution stderr)
      if (this.ctx.state.expansionStderr) {
        bodyResult = {
          ...bodyResult,
          stderr: this.ctx.state.expansionStderr + bodyResult.stderr
        };
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      // Apply output redirections before returning
      const bodyResult = failure(
        `bash: arithmetic expression: ${(error as Error).message}\n`
      );
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }

  private async executeConditionalCommand(
    node: ConditionalCommandNode
  ): Promise<ExecResult> {
    // Update currentLine for error messages
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    // Pre-open output redirects to truncate files BEFORE evaluating expression
    // This matches bash behavior where redirect files are opened before
    // any command substitutions in the conditional expression are evaluated
    const preOpenError = await preOpenOutputRedirects(
      this.ctx,
      node.redirections
    );
    if (preOpenError) {
      return preOpenError;
    }

    try {
      const condResult = await evaluateConditional(this.ctx, node.expression);
      // Apply output redirections
      let bodyResult = testResult(condResult);
      // Include any stderr from expansion (e.g., bad array subscript warnings)
      if (this.ctx.state.expansionStderr) {
        bodyResult = {
          ...bodyResult,
          stderr: this.ctx.state.expansionStderr + bodyResult.stderr
        };
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      // Apply output redirections before returning
      // ArithmeticError (e.g., division by zero) returns exit code 1
      // Other errors (e.g., invalid regex) return exit code 2
      const exitCode = error instanceof ArithmeticError ? 1 : 2;
      const bodyResult = failure(
        `bash: conditional expression: ${(error as Error).message}\n`,
        exitCode
      );
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }
}
