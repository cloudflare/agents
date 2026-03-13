/**
 * Execution Limits Configuration
 *
 * Centralized configuration for all execution limits to prevent runaway compute.
 * These limits can be overridden when creating a BashEnv instance.
 */

/**
 * Configuration for execution limits.
 * All limits are optional - undefined values use defaults.
 */
export interface ExecutionLimits {
  /** Maximum function call/recursion depth (default: 100) */
  maxCallDepth?: number;

  /** Maximum number of commands to execute (default: 10000) */
  maxCommandCount?: number;

  /** Maximum loop iterations for bash while/for/until loops (default: 10000) */
  maxLoopIterations?: number;

  /** Maximum loop iterations for AWK while/for loops (default: 10000) */
  maxAwkIterations?: number;

  /** Maximum command iterations for SED (branch loops) (default: 10000) */
  maxSedIterations?: number;

  /** Maximum iterations for jq loops (until, while, repeat) (default: 10000) */
  maxJqIterations?: number;

  /** Maximum sqlite3 query execution time in milliseconds (default: 5000) */
  maxSqliteTimeoutMs?: number;

  /** Maximum Python execution time in milliseconds (default: 10000, or 60000 with network) */
  maxPythonTimeoutMs?: number;

  /** Maximum JavaScript (js-exec) execution time in milliseconds (default: 10000, or 60000 with network) */
  maxJsTimeoutMs?: number;

  /** Maximum glob filesystem operations (default: 100000) */
  maxGlobOperations?: number;

  /** Maximum string length in bytes (default: 10MB = 10485760) */
  maxStringLength?: number;

  /** Maximum array elements (default: 100000) */
  maxArrayElements?: number;

  /** Maximum heredoc size in bytes (default: 10MB = 10485760) */
  maxHeredocSize?: number;

  /** Maximum command substitution nesting depth (default: 50) */
  maxSubstitutionDepth?: number;

  /** Maximum brace expansion results (default: 10000) */
  maxBraceExpansionResults?: number;

  /** Maximum total output size (stdout + stderr) in bytes (default: 10MB = 10485760) */
  maxOutputSize?: number;

  /** Maximum number of open file descriptors (default: 1024) */
  maxFileDescriptors?: number;

  /** Maximum source/. nesting depth (default: 100) */
  maxSourceDepth?: number;
}

/**
 * Default execution limits.
 * These are conservative limits designed to prevent runaway execution
 * while allowing reasonable scripts to complete.
 */
const DEFAULT_LIMITS: Required<ExecutionLimits> = {
  maxCallDepth: 100,
  maxCommandCount: 10000,
  maxLoopIterations: 10000,
  maxAwkIterations: 10000,
  maxSedIterations: 10000,
  maxJqIterations: 10000,
  maxSqliteTimeoutMs: 5000,
  maxPythonTimeoutMs: 10000,
  maxJsTimeoutMs: 10000,
  maxGlobOperations: 100000,
  maxStringLength: 10485760, // 10MB
  maxArrayElements: 100000,
  maxHeredocSize: 10485760, // 10MB
  maxSubstitutionDepth: 50,
  maxBraceExpansionResults: 10000,
  maxOutputSize: 10485760, // 10MB
  maxFileDescriptors: 1024,
  maxSourceDepth: 100
};

/**
 * Resolve execution limits by merging user-provided limits with defaults.
 */
export function resolveLimits(
  userLimits?: ExecutionLimits
): Required<ExecutionLimits> {
  if (!userLimits) {
    return { ...DEFAULT_LIMITS };
  }
  return {
    maxCallDepth: userLimits.maxCallDepth ?? DEFAULT_LIMITS.maxCallDepth,
    maxCommandCount:
      userLimits.maxCommandCount ?? DEFAULT_LIMITS.maxCommandCount,
    maxLoopIterations:
      userLimits.maxLoopIterations ?? DEFAULT_LIMITS.maxLoopIterations,
    maxAwkIterations:
      userLimits.maxAwkIterations ?? DEFAULT_LIMITS.maxAwkIterations,
    maxSedIterations:
      userLimits.maxSedIterations ?? DEFAULT_LIMITS.maxSedIterations,
    maxJqIterations:
      userLimits.maxJqIterations ?? DEFAULT_LIMITS.maxJqIterations,
    maxSqliteTimeoutMs:
      userLimits.maxSqliteTimeoutMs ?? DEFAULT_LIMITS.maxSqliteTimeoutMs,
    maxPythonTimeoutMs:
      userLimits.maxPythonTimeoutMs ?? DEFAULT_LIMITS.maxPythonTimeoutMs,
    maxJsTimeoutMs: userLimits.maxJsTimeoutMs ?? DEFAULT_LIMITS.maxJsTimeoutMs,
    maxGlobOperations:
      userLimits.maxGlobOperations ?? DEFAULT_LIMITS.maxGlobOperations,
    maxStringLength:
      userLimits.maxStringLength ?? DEFAULT_LIMITS.maxStringLength,
    maxArrayElements:
      userLimits.maxArrayElements ?? DEFAULT_LIMITS.maxArrayElements,
    maxHeredocSize: userLimits.maxHeredocSize ?? DEFAULT_LIMITS.maxHeredocSize,
    maxSubstitutionDepth:
      userLimits.maxSubstitutionDepth ?? DEFAULT_LIMITS.maxSubstitutionDepth,
    maxBraceExpansionResults:
      userLimits.maxBraceExpansionResults ??
      DEFAULT_LIMITS.maxBraceExpansionResults,
    maxOutputSize: userLimits.maxOutputSize ?? DEFAULT_LIMITS.maxOutputSize,
    maxFileDescriptors:
      userLimits.maxFileDescriptors ?? DEFAULT_LIMITS.maxFileDescriptors,
    maxSourceDepth: userLimits.maxSourceDepth ?? DEFAULT_LIMITS.maxSourceDepth
  };
}
