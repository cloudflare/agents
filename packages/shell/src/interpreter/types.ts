/**
 * Interpreter Types
 */

import type {
  CommandNode,
  FunctionDefNode,
  ScriptNode,
  StatementNode
} from "../ast/types";
import type { IFileSystem } from "../fs/interface";
import type { ExecutionLimits } from "../limits";
import type { SecureFetch } from "../network/index";
import type { CommandRegistry, ExecResult, TraceCallback } from "../types";

/**
 * Completion specification for a command, set by the `complete` builtin.
 */
export interface CompletionSpec {
  /** Word list for -W option */
  wordlist?: string;
  /** Function name for -F option */
  function?: string;
  /** Command to run for -C option */
  command?: string;
  /** Completion options (nospace, filenames, etc.) */
  options?: string[];
  /** Actions to perform (from -A option) */
  actions?: string[];
  /** Whether this is a default completion (-D) */
  isDefault?: boolean;
}

export interface ShellOptions {
  /** set -e: Exit immediately if a command exits with non-zero status */
  errexit: boolean;
  /** set -o pipefail: Return the exit status of the last (rightmost) command in a pipeline that fails */
  pipefail: boolean;
  /** set -u: Treat unset variables as an error when substituting */
  nounset: boolean;
  /** set -x: Print commands and their arguments as they are executed */
  xtrace: boolean;
  /** set -v: Print shell input lines as they are read (verbose) */
  verbose: boolean;
  /** set -o posix: POSIX mode for stricter compliance */
  posix: boolean;
  /** set -a: Export all variables */
  allexport: boolean;
  /** set -C: Prevent overwriting files with redirection */
  noclobber: boolean;
  /** set -f: Disable filename expansion (globbing) */
  noglob: boolean;
  /** set -n: Read commands but do not execute them (syntax check mode) */
  noexec: boolean;
  /** set -o vi: Use vi-style line editing (mutually exclusive with emacs) */
  vi: boolean;
  /** set -o emacs: Use emacs-style line editing (mutually exclusive with vi) */
  emacs: boolean;
}

export interface ShoptOptions {
  /** shopt -s extglob: Enable extended globbing patterns @(), *(), +(), ?(), !() */
  extglob: boolean;
  /** shopt -s dotglob: Include dotfiles in glob expansion */
  dotglob: boolean;
  /** shopt -s nullglob: Return empty for non-matching globs instead of literal pattern */
  nullglob: boolean;
  /** shopt -s failglob: Fail if glob pattern has no matches */
  failglob: boolean;
  /** shopt -s globstar: Enable ** recursive glob patterns */
  globstar: boolean;
  /** shopt -s globskipdots: Skip . and .. in glob patterns (default: true in bash >=5.2) */
  globskipdots: boolean;
  /** shopt -s nocaseglob: Case-insensitive glob matching */
  nocaseglob: boolean;
  /** shopt -s nocasematch: Case-insensitive pattern matching in [[ ]] and case */
  nocasematch: boolean;
  /** shopt -s expand_aliases: Enable alias expansion */
  expand_aliases: boolean;
  /** shopt -s lastpipe: Run last command of pipeline in current shell context */
  lastpipe: boolean;
  /** shopt -s xpg_echo: Make echo interpret backslash escapes by default (like echo -e) */
  xpg_echo: boolean;
}

// ============================================================================
// Variable Attribute State
// ============================================================================
// Tracks type attributes and special behaviors for shell variables.
// These are set via `declare`, `typeset`, `readonly`, `export`, etc.

/**
 * Tracks variable type attributes (declare -i, -l, -u, -n, -a, -A, etc.)
 * and export status. These affect how variables are read, written, and expanded.
 */
export interface VariableAttributeState {
  /** Set of variable names that are readonly */
  readonlyVars?: Set<string>;
  /** Set of variable names that are associative arrays */
  associativeArrays?: Set<string>;
  /** Set of variable names that are namerefs (declare -n) */
  namerefs?: Set<string>;
  /**
   * Set of nameref variable names that were "bound" to valid targets at creation time.
   * A bound nameref will always resolve through to its target, even if the target
   * is later unset. An unbound nameref (target didn't exist at creation) acts like
   * a regular variable, returning its raw value.
   */
  boundNamerefs?: Set<string>;
  /**
   * Set of nameref variable names that were created with an invalid target.
   * Invalid namerefs always read/write their value directly, never resolving.
   * For example, after `ref=1; typeset -n ref`, ref has an invalid target "1".
   */
  invalidNamerefs?: Set<string>;
  /** Set of variable names that have integer attribute (declare -i) */
  integerVars?: Set<string>;
  /** Set of variable names that have lowercase attribute (declare -l) */
  lowercaseVars?: Set<string>;
  /** Set of variable names that have uppercase attribute (declare -u) */
  uppercaseVars?: Set<string>;
  /** Set of exported variable names */
  exportedVars?: Set<string>;
  /** Set of temporarily exported variable names (for prefix assignments like FOO=bar cmd) */
  tempExportedVars?: Set<string>;
  /**
   * Stack of sets tracking variables exported within each local scope.
   * When a function returns and a local scope is popped, if a variable was
   * exported only in that scope (not before entering), the export attribute
   * should be removed. This enables bash's scoped export behavior where
   * `local V=x; export V` only exports the local, not the global.
   */
  localExportedVars?: Set<string>[];
  /** Set of variable names that have been declared but not assigned a value */
  declaredVars?: Set<string>;
}

// ============================================================================
// Local Variable Scoping State
// ============================================================================
// Implements bash's complex local variable scoping rules including:
// - Dynamic scoping (locals visible in called functions)
// - Nested local declarations (local inside eval inside function)
// - Unset behavior differences (local-unset vs dynamic-unset)
// - Tempenv bindings from prefix assignments (FOO=bar cmd)

/**
 * Tracks the complex local variable scoping machinery.
 * Bash's local variable behavior is intricate: variables are dynamically scoped,
 * can be declared multiple times in nested contexts, and have different unset
 * behaviors depending on whether the unset happens in the declaring scope.
 */
export interface LocalScopingState {
  /** Stack of local variable scopes (one Map per function call) */
  localScopes: Map<string, string | undefined>[];
  /**
   * Tracks at which call depth each local variable was declared.
   * Used for bash-specific unset scoping behavior:
   * - local-unset (same scope): value-unset (clears value, keeps local cell)
   * - dynamic-unset (different scope): cell-unset (removes local cell, exposes outer value)
   */
  localVarDepth?: Map<string, number>;
  /**
   * Stack of saved values for each local variable, supporting bash's localvar-nest behavior.
   * Each entry contains the saved (outer) value and the scope index where it was saved.
   * This allows multiple nested `local` declarations of the same variable (e.g., in nested evals)
   * to each have their own cell that can be unset independently.
   */
  localVarStack?: Map<
    string,
    Array<{ value: string | undefined; scopeIndex: number }>
  >;
  /**
   * Map of variable names to scope index where they were fully unset.
   * Used to prevent tempenv restoration after all local cells are removed.
   * Entries are cleared when their scope returns.
   */
  fullyUnsetLocals?: Map<string, number>;
  /**
   * Stack of temporary environment bindings from prefix assignments (e.g., FOO=bar cmd).
   * Each entry maps variable names to their saved (underlying) values.
   * Used for bash-specific unset behavior: when unsetting a variable that has a
   * tempenv binding, the unset should reveal the underlying value, not completely
   * remove the variable.
   */
  tempEnvBindings?: Map<string, string | undefined>[];
  /**
   * Set of tempenv variable names that have been explicitly written to within
   * the current function context (after the prefix assignment, before local).
   * Used to distinguish between "fresh" tempenvs (local-unset = value-unset)
   * and "mutated" tempenvs (local-unset reveals the mutated value).
   */
  mutatedTempEnvVars?: Set<string>;
  /**
   * Set of tempenv variable names that have been accessed (read or written)
   * within the current function context. Used to determine if a tempenv was
   * "observed" before a local declaration.
   */
  accessedTempEnvVars?: Set<string>;
}

// ============================================================================
// Call Stack State
// ============================================================================
// Tracks function calls and source file nesting for:
// - FUNCNAME, BASH_LINENO, BASH_SOURCE arrays
// - Proper return behavior from functions vs sourced scripts
// - Function definition context (which file defined a function)

/**
 * Tracks the function call stack and source file nesting.
 * This state powers the FUNCNAME, BASH_LINENO, and BASH_SOURCE arrays,
 * and determines the behavior of `return` in different contexts.
 */
export interface CallStackState {
  /** Function definitions (name -> AST node) */
  functions: Map<string, FunctionDefNode>;
  /** Current function call depth (for recursion limits and local scoping) */
  callDepth: number;
  /** Current source script nesting depth (for return in sourced scripts) */
  sourceDepth: number;
  /** Stack of call line numbers for BASH_LINENO */
  callLineStack?: number[];
  /** Stack of function names for FUNCNAME */
  funcNameStack?: string[];
  /** Stack of source files for BASH_SOURCE (tracks where functions were defined) */
  sourceStack?: string[];
  /** Current source file context (for function definitions) */
  currentSource?: string;
}

// ============================================================================
// Control Flow State
// ============================================================================
// Tracks loop nesting and condition context for:
// - break/continue with optional level argument
// - errexit (set -e) suppression in conditions
// - Subshell loop context for proper break/continue behavior

/**
 * Tracks loop nesting and condition context.
 * Used to implement break/continue commands and to suppress errexit
 * in condition contexts (if, while, until, ||, &&).
 */
export interface ControlFlowState {
  /** True when executing condition for if/while/until (errexit doesn't apply) */
  inCondition: boolean;
  /** Current loop nesting depth (for break/continue) */
  loopDepth: number;
  /** True if this subshell was spawned from within a loop context (for break/continue to exit subshell) */
  parentHasLoopContext?: boolean;
  /** True when the last executed statement's exit code is "safe" for errexit purposes
   *  (e.g., from a &&/|| chain where the failure wasn't the final command) */
  errexitSafe?: boolean;
}

// ============================================================================
// Process State
// ============================================================================
// Tracks process-related information for special variables:
// - $$ (shell PID), $BASHPID (current subshell PID)
// - $! (last background PID)
// - $SECONDS (time since shell start)

/**
 * Tracks process IDs, timing, and execution counts.
 * Powers special variables like $$, $BASHPID, $!, and $SECONDS.
 */
export interface ProcessState {
  /** Total commands executed (for execution limits) */
  commandCount: number;
  /** Time when shell started (for $SECONDS) */
  startTime: number;
  /** PID of last background job (for $!) */
  lastBackgroundPid: number;
  /** Current BASHPID (changes in subshells, unlike $$) */
  bashPid: number;
  /** Counter for generating unique virtual PIDs for subshells */
  nextVirtualPid: number;
  /** Virtual main shell PID for $$ (default 1, never exposes real process.pid) */
  virtualPid: number;
  /** Virtual parent PID for $PPID (default 0, never exposes real process.ppid) */
  virtualPpid: number;
  /** Virtual user ID for $UID/$EUID (default 1000, never exposes real UID) */
  virtualUid: number;
  /** Virtual group ID (default 1000, never exposes real GID) */
  virtualGid: number;
}

// ============================================================================
// I/O State
// ============================================================================
// Tracks file descriptors and stdin for:
// - Process substitution (<() and >())
// - Here-documents
// - Compound command stdin piping

/**
 * Tracks file descriptors and stdin content for I/O operations.
 * Used for process substitution, here-documents, and compound command stdin.
 */
export interface IOState {
  /** Stdin available for commands in compound commands (groups, subshells, while loops with piped input) */
  groupStdin?: string;
  /** File descriptors for process substitution and here-docs */
  fileDescriptors?: Map<number, string>;
  /** Next available file descriptor for {varname}>file allocation (starts at 10) */
  nextFd?: number;
}

// ============================================================================
// Expansion State
// ============================================================================
// Captures errors during parameter expansion that need to be reported
// after the expansion completes (arithmetic errors, etc.)

/**
 * Captures errors that occur during parameter expansion.
 * Some expansion errors need to be reported after expansion completes,
 * with their exit codes and stderr preserved.
 */
export interface ExpansionState {
  /** Exit code from expansion errors (arithmetic, etc.) - overrides command exit code */
  expansionExitCode?: number;
  /** Stderr from expansion errors */
  expansionStderr?: string;
}

// ============================================================================
// Interpreter State (Composed)
// ============================================================================
// The complete interpreter state, composed from the focused interfaces above.
// This provides backward compatibility while the sub-interfaces provide
// better organization for understanding and maintaining specific features.

/**
 * Complete interpreter state for bash script execution.
 *
 * This interface is composed from focused sub-interfaces:
 * - {@link VariableAttributeState} - Variable type attributes (readonly, integer, etc.)
 * - {@link LocalScopingState} - Local variable scoping machinery
 * - {@link CallStackState} - Function calls and source file tracking
 * - {@link ControlFlowState} - Loop nesting and condition context
 * - {@link ProcessState} - PIDs, timing, execution counts
 * - {@link IOState} - File descriptors and stdin
 * - {@link ExpansionState} - Expansion error capture
 */
export interface InterpreterState
  extends
    VariableAttributeState,
    LocalScopingState,
    CallStackState,
    ControlFlowState,
    ProcessState,
    IOState,
    ExpansionState {
  // ---- Core Environment ----
  /** Environment variables (exported to commands) - uses Map to prevent prototype pollution */
  env: Map<string, string>;
  /** Current working directory */
  cwd: string;
  /** Previous directory (for `cd -`) */
  previousDir: string;

  // ---- Execution Tracking ----
  /** Exit code of last executed command */
  lastExitCode: number;
  /** Last argument of previous command, for $_ expansion */
  lastArg: string;
  /** Current line number being executed (for $LINENO) */
  currentLine: number;

  // ---- Shell Options ----
  /** Shell options (set -e, etc.) */
  options: ShellOptions;
  /** Shopt options (shopt -s, etc.) */
  shoptOptions: ShoptOptions;

  // ---- Shell Features ----
  /** Completion specifications set by the `complete` builtin */
  completionSpecs?: Map<string, CompletionSpec>;
  /** Directory stack for pushd/popd/dirs */
  directoryStack?: string[];
  /** Hash table for PATH command lookup caching */
  hashTable?: Map<string, string>;

  // ---- Output Control ----
  /**
   * Suppress verbose mode output (set -v) when inside command substitutions.
   * bash only prints verbose output for the main script, not for commands
   * inside $(...) or backticks.
   */
  suppressVerbose?: boolean;

  /**
   * Abort signal for cooperative cancellation.
   * Checked at statement boundaries; when aborted, execution stops.
   */
  signal?: AbortSignal;
  /** Extra arguments injected via exec({ args }), appended to first command's args */
  extraArgs?: string[];
}

export interface InterpreterContext {
  state: InterpreterState;
  fs: IFileSystem;
  commands: CommandRegistry;
  /** Execution limits configuration */
  limits: Required<ExecutionLimits>;
  execFn: (
    script: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      replaceEnv?: boolean;
      signal?: AbortSignal;
      args?: string[];
    }
  ) => Promise<ExecResult>;
  executeScript: (node: ScriptNode) => Promise<ExecResult>;
  executeStatement: (node: StatementNode) => Promise<ExecResult>;
  executeCommand: (node: CommandNode, stdin: string) => Promise<ExecResult>;
  /** Optional secure fetch function for network-enabled commands */
  fetch?: SecureFetch;
  /** Optional sleep function for testing with mock clocks */
  sleep?: (ms: number) => Promise<void>;
  /** Optional trace callback for performance profiling */
  trace?: TraceCallback;
  /** Current command substitution nesting depth (for limit enforcement) */
  substitutionDepth?: number;
}
