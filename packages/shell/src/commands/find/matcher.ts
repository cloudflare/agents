// Matcher functions for find command

import { createUserRegex } from "../../regex/index";
import { matchGlob } from "../../utils/glob";
import type { EvalContext, EvalResult, Expression } from "./types";

/**
 * Evaluate a find expression and return both match result and prune flag.
 * The prune flag is set when -prune is evaluated and returns true.
 */
export function evaluateExpressionWithPrune(
  expr: Expression,
  ctx: EvalContext
): EvalResult {
  switch (expr.type) {
    case "name": {
      // Fast path: check extension before full glob match for patterns like "*.json"
      const pattern = expr.pattern;
      const extMatch = pattern.match(/^\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        const name = ctx.name;
        // Quick extension check - if extension doesn't match, skip glob
        if (expr.ignoreCase) {
          if (!name.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!name.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
        // For "*.ext" patterns, endsWith is sufficient if it passed
        return { matches: true, pruned: false, printed: false };
      }
      return {
        matches: matchGlob(ctx.name, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "path": {
      // Fast paths for common patterns
      const pattern = expr.pattern;
      const path = ctx.relativePath;

      // Fast path 1: Check for required directory segments (e.g., "*/pulls/*" requires "/pulls/")
      // Look for literal path segments in the pattern
      const segments = pattern.split("/");
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        // If segment is literal (no wildcards) and not special (. or ..), path must contain this segment
        if (
          seg &&
          seg !== "." &&
          seg !== ".." &&
          !seg.includes("*") &&
          !seg.includes("?") &&
          !seg.includes("[")
        ) {
          const requiredSegment = `/${seg}/`;
          if (expr.ignoreCase) {
            if (!path.toLowerCase().includes(requiredSegment.toLowerCase())) {
              return { matches: false, pruned: false, printed: false };
            }
          } else {
            if (!path.includes(requiredSegment)) {
              return { matches: false, pruned: false, printed: false };
            }
          }
        }
      }

      // Fast path 2: Check extension before full glob match for patterns like "*.json"
      const extMatch = pattern.match(/\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        // Quick extension check - if extension doesn't match, skip glob
        if (expr.ignoreCase) {
          if (!path.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!path.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
      }

      return {
        matches: matchGlob(path, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "regex": {
      try {
        const flags = expr.ignoreCase ? "i" : "";
        const regex = createUserRegex(expr.pattern, flags);
        return {
          matches: regex.test(ctx.relativePath),
          pruned: false,
          printed: false
        };
      } catch {
        return { matches: false, pruned: false, printed: false };
      }
    }
    case "type":
      if (expr.fileType === "f")
        return { matches: ctx.isFile, pruned: false, printed: false };
      if (expr.fileType === "d")
        return { matches: ctx.isDirectory, pruned: false, printed: false };
      return { matches: false, pruned: false, printed: false };
    case "empty":
      return { matches: ctx.isEmpty, pruned: false, printed: false };
    case "mtime": {
      const now = Date.now();
      const fileAgeDays = (now - ctx.mtime) / (1000 * 60 * 60 * 24);
      let matches: boolean;
      if (expr.comparison === "more") {
        matches = fileAgeDays > expr.days;
      } else if (expr.comparison === "less") {
        matches = fileAgeDays < expr.days;
      } else {
        matches = Math.floor(fileAgeDays) === expr.days;
      }
      return { matches, pruned: false, printed: false };
    }
    case "newer": {
      const refMtime = ctx.newerRefTimes.get(expr.refPath);
      if (refMtime === undefined)
        return { matches: false, pruned: false, printed: false };
      return { matches: ctx.mtime > refMtime, pruned: false, printed: false };
    }
    case "size": {
      let targetBytes = expr.value;
      switch (expr.unit) {
        case "c":
          targetBytes = expr.value;
          break;
        case "k":
          targetBytes = expr.value * 1024;
          break;
        case "M":
          targetBytes = expr.value * 1024 * 1024;
          break;
        case "G":
          targetBytes = expr.value * 1024 * 1024 * 1024;
          break;
        case "b":
          targetBytes = expr.value * 512;
          break;
      }
      let matches: boolean;
      if (expr.comparison === "more") {
        matches = ctx.size > targetBytes;
      } else if (expr.comparison === "less") {
        matches = ctx.size < targetBytes;
      } else if (expr.unit === "b") {
        const fileBlocks = Math.ceil(ctx.size / 512);
        matches = fileBlocks === expr.value;
      } else {
        matches = ctx.size === targetBytes;
      }
      return { matches, pruned: false, printed: false };
    }
    case "perm": {
      const fileMode = ctx.mode & 0o777;
      const targetMode = expr.mode & 0o777;
      let matches: boolean;
      if (expr.matchType === "exact") {
        matches = fileMode === targetMode;
      } else if (expr.matchType === "all") {
        matches = (fileMode & targetMode) === targetMode;
      } else {
        matches = (fileMode & targetMode) !== 0;
      }
      return { matches, pruned: false, printed: false };
    }
    case "prune":
      // -prune always returns true and sets the prune flag
      return { matches: true, pruned: true, printed: false };
    case "print":
      // -print always returns true and sets the print flag
      return { matches: true, pruned: false, printed: true };
    case "not": {
      const inner = evaluateExpressionWithPrune(expr.expr, ctx);
      return { matches: !inner.matches, pruned: inner.pruned, printed: false };
    }
    case "and": {
      const left = evaluateExpressionWithPrune(expr.left, ctx);
      if (!left.matches) {
        // Short-circuit: if left is false, prune from left is still propagated
        return { matches: false, pruned: left.pruned, printed: false };
      }
      const right = evaluateExpressionWithPrune(expr.right, ctx);
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: left.printed || right.printed
      };
    }
    case "or": {
      const left = evaluateExpressionWithPrune(expr.left, ctx);
      if (left.matches) {
        // Short-circuit: return left result (including prune and printed)
        return left;
      }
      const right = evaluateExpressionWithPrune(expr.right, ctx);
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: right.printed // Only use right's printed since left didn't match
      };
    }
  }
}

/**
 * Check if an expression needs full stat metadata (size, mtime, mode)
 * vs just type info (isFile/isDirectory) which can come from dirent
 */
export function expressionNeedsStatMetadata(expr: Expression | null): boolean {
  if (!expr) return false;

  switch (expr.type) {
    // These only need name/path/type - available without stat
    case "name":
    case "path":
    case "regex":
    case "type":
    case "prune":
    case "print":
      return false;

    // These need stat metadata
    case "empty": // needs size for files
    case "mtime":
    case "newer":
    case "size":
    case "perm":
      return true;

    // Compound expressions - check children
    case "not":
      return expressionNeedsStatMetadata(expr.expr);
    case "and":
    case "or":
      return (
        expressionNeedsStatMetadata(expr.left) ||
        expressionNeedsStatMetadata(expr.right)
      );
  }
}

/**
 * Check if an expression uses -empty (needs directory entry count)
 */
export function expressionNeedsEmptyCheck(expr: Expression | null): boolean {
  if (!expr) return false;

  switch (expr.type) {
    case "empty":
      return true;
    case "not":
      return expressionNeedsEmptyCheck(expr.expr);
    case "and":
    case "or":
      return (
        expressionNeedsEmptyCheck(expr.left) ||
        expressionNeedsEmptyCheck(expr.right)
      );
    default:
      return false;
  }
}

/**
 * Analyze a path expression for pruning opportunities.
 * For patterns like "*\/pulls\/*.json", we can skip descending into "pulls" subdirectories
 * since files must be directly inside "pulls".
 */
export interface PathPruningHint {
  /** If set, when in a directory with this name, don't descend into subdirs */
  terminalDirName: string | null;
  /** If set, files must have this extension (e.g., ".json") */
  requiredExtension: string | null;
}

/**
 * Extract path pruning hints from an expression tree.
 * Returns hints that can be used to skip unnecessary directory traversal.
 */
export function extractPathPruningHints(
  expr: Expression | null
): PathPruningHint {
  const hint: PathPruningHint = {
    terminalDirName: null,
    requiredExtension: null
  };
  if (!expr) return hint;

  // Look for path expressions combined with type:f
  // For pattern "*/X/*" (where X is literal), X is a terminal directory
  const pathExprs = collectPathExpressions(expr);
  const hasTypeFile = hasTypeFileFilter(expr);

  if (hasTypeFile && pathExprs.length === 1) {
    const pattern = pathExprs[0];
    // Parse pattern: look for */literal/* or */literal/*.ext patterns
    const parts = pattern.split("/").filter((p) => p.length > 0);

    // Check if pattern is */X/* or */X/*.ext where X is literal
    // (at least 3 parts, middle one is literal, last one is wildcard)
    if (parts.length >= 2) {
      // Find the last literal segment before the filename pattern
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        if (
          !part.includes("*") &&
          !part.includes("?") &&
          !part.includes("[") &&
          part !== "." &&
          part !== ".."
        ) {
          // This is a literal directory name
          // Check if the next part (filename) is a wildcard pattern
          const nextPart = parts[i + 1];
          if (nextPart && (nextPart.includes("*") || nextPart.includes("?"))) {
            hint.terminalDirName = part;
            // Extract extension from patterns like "*.json"
            const extMatch = nextPart.match(/^\*(\.[a-zA-Z0-9]+)$/);
            if (extMatch) {
              hint.requiredExtension = extMatch[1];
            }
          }
          break;
        }
      }
    }
  }

  return hint;
}

function collectPathExpressions(expr: Expression): string[] {
  const paths: string[] = [];
  const collect = (e: Expression): void => {
    if (e.type === "path") {
      paths.push(e.pattern);
    } else if (e.type === "not") {
      collect(e.expr);
    } else if (e.type === "and" || e.type === "or") {
      collect(e.left);
      collect(e.right);
    }
  };
  collect(expr);
  return paths;
}

function hasTypeFileFilter(expr: Expression): boolean {
  const check = (e: Expression): boolean => {
    if (e.type === "type" && e.fileType === "f") return true;
    if (e.type === "not") return check(e.expr);
    if (e.type === "and") return check(e.left) || check(e.right);
    if (e.type === "or") return check(e.left) || check(e.right);
    return false;
  };
  return check(expr);
}

// Helper to collect and resolve -newer reference file mtimes
export function collectNewerRefs(expr: Expression | null): string[] {
  const refs: string[] = [];

  const collect = (e: Expression | null): void => {
    if (!e) return;
    if (e.type === "newer") {
      refs.push(e.refPath);
    } else if (e.type === "not") {
      collect(e.expr);
    } else if (e.type === "and" || e.type === "or") {
      collect(e.left);
      collect(e.right);
    }
  };

  collect(expr);
  return refs;
}

/**
 * Context for early prune evaluation (before readdir).
 * Only includes info available without reading directory contents or stat.
 */
export interface EarlyEvalContext {
  name: string;
  relativePath: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Check if an expression is "simple" - only uses name/path/regex/type/prune/print.
 * Simple expressions can be evaluated without creating EvalContext objects.
 */
export function isSimpleExpression(expr: Expression | null): boolean {
  if (!expr) return true;

  switch (expr.type) {
    // These only need name/path/type
    case "name":
    case "path":
    case "regex":
    case "type":
    case "prune":
    case "print":
      return true;

    // These need stat metadata or directory contents
    case "empty":
    case "mtime":
    case "newer":
    case "size":
    case "perm":
      return false;

    // Compound expressions - check children
    case "not":
      return isSimpleExpression(expr.expr);
    case "and":
    case "or":
      return isSimpleExpression(expr.left) && isSimpleExpression(expr.right);
  }
}

/**
 * Fast-path evaluator for simple expressions.
 * Avoids creating EvalContext objects by taking arguments directly.
 * Only use this when isSimpleExpression() returns true.
 */
export function evaluateSimpleExpression(
  expr: Expression,
  name: string,
  relativePath: string,
  isFile: boolean,
  isDirectory: boolean
): EvalResult {
  switch (expr.type) {
    case "name": {
      // Fast path: check extension before full glob match for patterns like "*.json"
      const pattern = expr.pattern;
      const extMatch = pattern.match(/^\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        // Quick extension check
        if (expr.ignoreCase) {
          if (!name.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!name.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
        return { matches: true, pruned: false, printed: false };
      }
      return {
        matches: matchGlob(name, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "path": {
      const pattern = expr.pattern;
      // Fast path: Check for required directory segments
      const segments = pattern.split("/");
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (
          seg &&
          seg !== "." &&
          seg !== ".." &&
          !seg.includes("*") &&
          !seg.includes("?") &&
          !seg.includes("[")
        ) {
          const requiredSegment = `/${seg}/`;
          if (expr.ignoreCase) {
            if (
              !relativePath
                .toLowerCase()
                .includes(requiredSegment.toLowerCase())
            ) {
              return { matches: false, pruned: false, printed: false };
            }
          } else {
            if (!relativePath.includes(requiredSegment)) {
              return { matches: false, pruned: false, printed: false };
            }
          }
        }
      }
      // Fast path: Check extension
      const extMatch = pattern.match(/\*(\.[a-zA-Z0-9]+)$/);
      if (extMatch) {
        const requiredExt = extMatch[1];
        if (expr.ignoreCase) {
          if (!relativePath.toLowerCase().endsWith(requiredExt.toLowerCase())) {
            return { matches: false, pruned: false, printed: false };
          }
        } else {
          if (!relativePath.endsWith(requiredExt)) {
            return { matches: false, pruned: false, printed: false };
          }
        }
      }
      return {
        matches: matchGlob(relativePath, pattern, expr.ignoreCase),
        pruned: false,
        printed: false
      };
    }
    case "regex": {
      try {
        const flags = expr.ignoreCase ? "i" : "";
        const regex = createUserRegex(expr.pattern, flags);
        return {
          matches: regex.test(relativePath),
          pruned: false,
          printed: false
        };
      } catch {
        return { matches: false, pruned: false, printed: false };
      }
    }
    case "type":
      if (expr.fileType === "f")
        return { matches: isFile, pruned: false, printed: false };
      if (expr.fileType === "d")
        return { matches: isDirectory, pruned: false, printed: false };
      return { matches: false, pruned: false, printed: false };
    case "prune":
      return { matches: true, pruned: true, printed: false };
    case "print":
      return { matches: true, pruned: false, printed: true };
    case "not": {
      const inner = evaluateSimpleExpression(
        expr.expr,
        name,
        relativePath,
        isFile,
        isDirectory
      );
      return { matches: !inner.matches, pruned: inner.pruned, printed: false };
    }
    case "and": {
      const left = evaluateSimpleExpression(
        expr.left,
        name,
        relativePath,
        isFile,
        isDirectory
      );
      if (!left.matches) {
        return { matches: false, pruned: left.pruned, printed: false };
      }
      const right = evaluateSimpleExpression(
        expr.right,
        name,
        relativePath,
        isFile,
        isDirectory
      );
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: left.printed || right.printed
      };
    }
    case "or": {
      const left = evaluateSimpleExpression(
        expr.left,
        name,
        relativePath,
        isFile,
        isDirectory
      );
      if (left.matches) {
        return left;
      }
      const right = evaluateSimpleExpression(
        expr.right,
        name,
        relativePath,
        isFile,
        isDirectory
      );
      return {
        matches: right.matches,
        pruned: left.pruned || right.pruned,
        printed: right.printed
      };
    }
    default:
      // For non-simple expressions, this shouldn't be called
      return { matches: false, pruned: false, printed: false };
  }
}

/**
 * Check if an expression contains -prune and can potentially be evaluated
 * early (before readdir) to avoid unnecessary I/O.
 */
export function expressionHasPrune(expr: Expression | null): boolean {
  if (!expr) return false;

  switch (expr.type) {
    case "prune":
      return true;
    case "not":
      return expressionHasPrune(expr.expr);
    case "and":
    case "or":
      return expressionHasPrune(expr.left) || expressionHasPrune(expr.right);
    default:
      return false;
  }
}

/**
 * Check if an expression can be evaluated with only early context
 * (name, path, type) without needing stat or directory contents.
 */
function canEvaluateExpressionEarly(expr: Expression): boolean {
  switch (expr.type) {
    // These only need name/path/type
    case "name":
    case "path":
    case "regex":
    case "type":
    case "prune":
    case "print":
      return true;

    // These need stat metadata or directory contents
    case "empty":
    case "mtime":
    case "newer":
    case "size":
    case "perm":
      return false;

    // Compound expressions - check children
    case "not":
      return canEvaluateExpressionEarly(expr.expr);
    case "and":
    case "or":
      return (
        canEvaluateExpressionEarly(expr.left) &&
        canEvaluateExpressionEarly(expr.right)
      );
  }
}

/**
 * Evaluate an expression for early prune detection.
 * Returns { shouldPrune: true } if we should skip reading this directory.
 * Returns { shouldPrune: false } if we can't determine or shouldn't prune.
 *
 * This is used to avoid reading directory contents when we know we'll prune.
 * For expressions that need stat info, we conservatively return false.
 */
export function evaluateForEarlyPrune(
  expr: Expression | null,
  ctx: EarlyEvalContext
): { shouldPrune: boolean } {
  if (!expr || !ctx.isDirectory) {
    return { shouldPrune: false };
  }

  // Only try early evaluation if the expression can be fully evaluated early
  // Otherwise we might miss prune conditions
  if (!canEvaluateExpressionEarly(expr)) {
    // For expressions with stat-dependent parts, we need to check if the
    // prune-triggering path can still be evaluated early.
    // For example: `-name foo -prune -o -size +1M -print`
    // The left branch (prune) can be evaluated early even though right needs stat.
    return evaluatePruneBranchEarly(expr, ctx);
  }

  // Full expression can be evaluated early - use normal evaluation
  const evalCtx: EvalContext = {
    name: ctx.name,
    relativePath: ctx.relativePath,
    isFile: ctx.isFile,
    isDirectory: ctx.isDirectory,
    isEmpty: false, // Not available early
    mtime: 0,
    size: 0,
    mode: 0,
    newerRefTimes: new Map()
  };

  const result = evaluateExpressionWithPrune(expr, evalCtx);
  return { shouldPrune: result.pruned };
}

/**
 * For expressions with stat-dependent parts, try to evaluate just the
 * prune-triggering branches early.
 *
 * Common pattern: `-name X -prune -o <other conditions>`
 * The left branch of OR can often be evaluated early.
 */
function evaluatePruneBranchEarly(
  expr: Expression,
  ctx: EarlyEvalContext
): { shouldPrune: boolean } {
  switch (expr.type) {
    case "or": {
      // For OR, if left branch can be evaluated early and triggers prune, use it
      if (canEvaluateExpressionEarly(expr.left)) {
        const evalCtx: EvalContext = {
          name: ctx.name,
          relativePath: ctx.relativePath,
          isFile: ctx.isFile,
          isDirectory: ctx.isDirectory,
          isEmpty: false,
          mtime: 0,
          size: 0,
          mode: 0,
          newerRefTimes: new Map()
        };
        const leftResult = evaluateExpressionWithPrune(expr.left, evalCtx);
        if (leftResult.pruned) {
          return { shouldPrune: true };
        }
      }
      // Also check right branch
      return evaluatePruneBranchEarly(expr.right, ctx);
    }
    case "and": {
      // For AND, both sides must match for prune to trigger
      // Only evaluate early if both can be evaluated early
      if (
        canEvaluateExpressionEarly(expr.left) &&
        canEvaluateExpressionEarly(expr.right)
      ) {
        const evalCtx: EvalContext = {
          name: ctx.name,
          relativePath: ctx.relativePath,
          isFile: ctx.isFile,
          isDirectory: ctx.isDirectory,
          isEmpty: false,
          mtime: 0,
          size: 0,
          mode: 0,
          newerRefTimes: new Map()
        };
        const result = evaluateExpressionWithPrune(expr, evalCtx);
        return { shouldPrune: result.pruned };
      }
      // Check if left is early-evaluable and contains prune logic
      if (canEvaluateExpressionEarly(expr.left)) {
        const evalCtx: EvalContext = {
          name: ctx.name,
          relativePath: ctx.relativePath,
          isFile: ctx.isFile,
          isDirectory: ctx.isDirectory,
          isEmpty: false,
          mtime: 0,
          size: 0,
          mode: 0,
          newerRefTimes: new Map()
        };
        const leftResult = evaluateExpressionWithPrune(expr.left, evalCtx);
        // If left doesn't match, AND will be false, no pruning
        if (!leftResult.matches) {
          return { shouldPrune: false };
        }
        // Left matches, check right for prune
        return evaluatePruneBranchEarly(expr.right, ctx);
      }
      return { shouldPrune: false };
    }
    case "not":
      // -not doesn't typically wrap -prune in useful ways
      return { shouldPrune: false };
    default:
      return { shouldPrune: false };
  }
}
