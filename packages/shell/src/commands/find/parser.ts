// Parser for find expressions

import type { Expression, FindAction, ParseResult, SizeUnit } from "./types";

// Token types for parsing
type Token =
  | { type: "expr"; expr: Expression }
  | { type: "op"; op: "and" | "or" }
  | { type: "not" }
  | { type: "lparen" }
  | { type: "rparen" };

export function parseExpressions(
  args: string[],
  startIndex: number
): ParseResult {
  // Parse into tokens: expressions, operators, negations, and parentheses
  const tokens: Token[] = [];
  const actions: FindAction[] = [];
  let i = startIndex;

  while (i < args.length) {
    const arg = args[i];

    // Handle parentheses for grouping
    if (arg === "(" || arg === "\\(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (arg === ")" || arg === "\\)") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }

    if (arg === "-name" && i + 1 < args.length) {
      tokens.push({ type: "expr", expr: { type: "name", pattern: args[++i] } });
    } else if (arg === "-iname" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "name", pattern: args[++i], ignoreCase: true }
      });
    } else if (arg === "-path" && i + 1 < args.length) {
      tokens.push({ type: "expr", expr: { type: "path", pattern: args[++i] } });
    } else if (arg === "-ipath" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "path", pattern: args[++i], ignoreCase: true }
      });
    } else if (arg === "-regex" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "regex", pattern: args[++i] }
      });
    } else if (arg === "-iregex" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "regex", pattern: args[++i], ignoreCase: true }
      });
    } else if (arg === "-type" && i + 1 < args.length) {
      const fileType = args[++i];
      if (fileType === "f" || fileType === "d") {
        tokens.push({ type: "expr", expr: { type: "type", fileType } });
      } else {
        return {
          expr: null,
          pathIndex: i,
          error: `find: Unknown argument to -type: ${fileType}\n`,
          actions: []
        };
      }
    } else if (arg === "-empty") {
      tokens.push({ type: "expr", expr: { type: "empty" } });
    } else if (arg === "-mtime" && i + 1 < args.length) {
      const mtimeArg = args[++i];
      let comparison: "exact" | "more" | "less" = "exact";
      let daysStr = mtimeArg;
      if (mtimeArg.startsWith("+")) {
        comparison = "more";
        daysStr = mtimeArg.slice(1);
      } else if (mtimeArg.startsWith("-")) {
        comparison = "less";
        daysStr = mtimeArg.slice(1);
      }
      const days = parseInt(daysStr, 10);
      if (!Number.isNaN(days)) {
        tokens.push({
          type: "expr",
          expr: { type: "mtime", days, comparison }
        });
      }
    } else if (arg === "-newer" && i + 1 < args.length) {
      const refPath = args[++i];
      tokens.push({ type: "expr", expr: { type: "newer", refPath } });
    } else if (arg === "-size" && i + 1 < args.length) {
      const sizeArg = args[++i];
      let comparison: "exact" | "more" | "less" = "exact";
      let sizeStr = sizeArg;
      if (sizeArg.startsWith("+")) {
        comparison = "more";
        sizeStr = sizeArg.slice(1);
      } else if (sizeArg.startsWith("-")) {
        comparison = "less";
        sizeStr = sizeArg.slice(1);
      }
      // Parse size with optional suffix (c=bytes, k=KB, M=MB, G=GB, default=512-byte blocks)
      const sizeMatch = sizeStr.match(/^(\d+)([ckMGb])?$/);
      if (sizeMatch) {
        const value = parseInt(sizeMatch[1], 10);
        const unit = (sizeMatch[2] || "b") as SizeUnit;
        tokens.push({
          type: "expr",
          expr: { type: "size", value, unit, comparison }
        });
      }
    } else if (arg === "-perm" && i + 1 < args.length) {
      const permArg = args[++i];
      // Parse permission mode: octal, -mode (all bits), /mode (any bit)
      let matchType: "exact" | "all" | "any" = "exact";
      let modeStr = permArg;
      if (permArg.startsWith("-")) {
        matchType = "all";
        modeStr = permArg.slice(1);
      } else if (permArg.startsWith("/")) {
        matchType = "any";
        modeStr = permArg.slice(1);
      }
      // Parse as octal
      const mode = parseInt(modeStr, 8);
      if (!Number.isNaN(mode)) {
        tokens.push({
          type: "expr",
          expr: { type: "perm", mode, matchType }
        });
      }
    } else if (arg === "-prune") {
      tokens.push({ type: "expr", expr: { type: "prune" } });
    } else if (arg === "-not" || arg === "!") {
      tokens.push({ type: "not" });
    } else if (arg === "-o" || arg === "-or") {
      tokens.push({ type: "op", op: "or" });
    } else if (arg === "-a" || arg === "-and") {
      tokens.push({ type: "op", op: "and" });
    } else if (arg === "-maxdepth" || arg === "-mindepth") {
      // These are handled separately, skip them
      i++;
    } else if (arg === "-depth") {
      // Handled separately in find.ts, skip it
    } else if (arg === "-exec") {
      // Parse -exec command {} ; or -exec command {} +
      const commandParts: string[] = [];
      i++;
      while (i < args.length && args[i] !== ";" && args[i] !== "+") {
        commandParts.push(args[i]);
        i++;
      }
      if (i >= args.length) {
        return {
          expr: null,
          pathIndex: i,
          error: "find: missing argument to `-exec'\n",
          actions: []
        };
      }
      const batchMode = args[i] === "+";
      actions.push({ type: "exec", command: commandParts, batchMode });
    } else if (arg === "-print") {
      // -print is both an expression (returns true, marks for printing) and an action
      tokens.push({ type: "expr", expr: { type: "print" } });
      actions.push({ type: "print" });
    } else if (arg === "-print0") {
      actions.push({ type: "print0" });
    } else if (arg === "-printf" && i + 1 < args.length) {
      const format = args[++i];
      actions.push({ type: "printf", format });
    } else if (arg === "-delete") {
      actions.push({ type: "delete" });
    } else if (arg.startsWith("-")) {
      // Unknown predicate
      return {
        expr: null,
        pathIndex: i,
        error: `find: unknown predicate '${arg}'\n`,
        actions: []
      };
    } else {
      // This is the path - skip if at start, otherwise stop
      if (tokens.length === 0) {
        i++;
        continue;
      }
      break;
    }
    i++;
  }

  if (tokens.length === 0) {
    return { expr: null, pathIndex: i, actions };
  }

  // Build expression tree using recursive descent parsing
  // Handles: parentheses > NOT > AND > OR (precedence high to low)
  const result = buildExpressionTree(tokens);
  if (result.error) {
    return { expr: null, pathIndex: i, error: result.error, actions };
  }

  return { expr: result.expr, pathIndex: i, actions };
}

/**
 * Recursive descent parser for find expressions with proper precedence:
 * - Parentheses have highest precedence
 * - NOT binds tightly to the next expression
 * - AND (implicit or explicit) binds tighter than OR
 * - OR has lowest precedence
 */
function buildExpressionTree(tokens: Token[]): {
  expr: Expression | null;
  error?: string;
} {
  let pos = 0;

  // Parse OR expressions (lowest precedence)
  function parseOr(): Expression | null {
    let left = parseAnd();
    if (!left) return null;

    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.type === "op" && token.op === "or") {
        pos++;
        const right = parseAnd();
        if (!right) return left;
        left = { type: "or", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  // Parse AND expressions (implicit or explicit -a)
  function parseAnd(): Expression | null {
    let left = parseNot();
    if (!left) return null;

    while (pos < tokens.length) {
      const token = tokens[pos];
      // Explicit AND
      if (token.type === "op" && token.op === "and") {
        pos++;
        const right = parseNot();
        if (!right) return left;
        left = { type: "and", left, right };
      }
      // Implicit AND: two adjacent expressions (not OR, not rparen)
      else if (
        token.type === "expr" ||
        token.type === "not" ||
        token.type === "lparen"
      ) {
        const right = parseNot();
        if (!right) return left;
        left = { type: "and", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  // Parse NOT expressions
  function parseNot(): Expression | null {
    if (pos < tokens.length && tokens[pos].type === "not") {
      pos++;
      const expr = parseNot(); // NOT can chain: ! ! expr
      if (!expr) return null;
      return { type: "not", expr };
    }
    return parsePrimary();
  }

  // Parse primary expressions (atoms and parenthesized groups)
  function parsePrimary(): Expression | null {
    if (pos >= tokens.length) return null;

    const token = tokens[pos];

    // Parenthesized group
    if (token.type === "lparen") {
      pos++;
      const expr = parseOr();
      // Consume closing paren if present
      if (pos < tokens.length && tokens[pos].type === "rparen") {
        pos++;
      }
      return expr;
    }

    // Simple expression
    if (token.type === "expr") {
      pos++;
      return token.expr;
    }

    // Skip rparen (handled by lparen case)
    if (token.type === "rparen") {
      return null;
    }

    return null;
  }

  const expr = parseOr();
  return { expr };
}
