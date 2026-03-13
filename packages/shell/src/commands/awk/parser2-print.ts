/**
 * AWK Parser Print Context Helpers
 *
 * Handles parsing in print/printf context where > and >> are redirection
 * operators rather than comparison operators.
 */

import type {
  AwkArrayAccess,
  AwkExpr,
  AwkFieldRef,
  AwkStmt,
  AwkVariable
} from "./ast";
import type { Token, TokenType } from "./lexer";

/**
 * Interface for parser methods needed by print parsing helpers.
 * Used to avoid circular dependencies.
 */
export interface PrintParserContext {
  tokens: Token[];
  pos: number;
  current(): Token;
  advance(): Token;
  match(...types: TokenType[]): boolean;
  check(type: TokenType): boolean;
  expect(type: TokenType, message?: string): Token;
  skipNewlines(): void;
  parseExpression(): AwkExpr;
  parseTernary(): AwkExpr;
  parsePrimary(): AwkExpr;
  parseAddSub(): AwkExpr;
  setPos(pos: number): void;
}

// Token type values for use in this module
const TokenTypes = {
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  QUESTION: "QUESTION",
  NEWLINE: "NEWLINE",
  SEMICOLON: "SEMICOLON",
  RBRACE: "RBRACE",
  COMMA: "COMMA",
  PIPE: "PIPE",
  GT: "GT",
  APPEND: "APPEND",
  AND: "AND",
  OR: "OR",
  ASSIGN: "ASSIGN",
  PLUS_ASSIGN: "PLUS_ASSIGN",
  MINUS_ASSIGN: "MINUS_ASSIGN",
  STAR_ASSIGN: "STAR_ASSIGN",
  SLASH_ASSIGN: "SLASH_ASSIGN",
  PERCENT_ASSIGN: "PERCENT_ASSIGN",
  CARET_ASSIGN: "CARET_ASSIGN",
  RBRACKET: "RBRACKET",
  COLON: "COLON",
  IN: "IN",
  PRINT: "PRINT",
  PRINTF: "PRINTF",
  IDENT: "IDENT",
  LT: "LT",
  LE: "LE",
  GE: "GE",
  EQ: "EQ",
  NE: "NE",
  MATCH: "MATCH",
  NOT_MATCH: "NOT_MATCH",
  NUMBER: "NUMBER",
  STRING: "STRING",
  DOLLAR: "DOLLAR",
  NOT: "NOT",
  MINUS: "MINUS",
  PLUS: "PLUS",
  INCREMENT: "INCREMENT",
  DECREMENT: "DECREMENT"
} as const;

/**
 * Parse a print statement.
 */
export function parsePrintStatement(p: PrintParserContext): AwkStmt {
  p.expect(TokenTypes.PRINT as TokenType);

  const args: AwkExpr[] = [];

  // Check for empty print (print $0)
  if (
    p.check(TokenTypes.NEWLINE as TokenType) ||
    p.check(TokenTypes.SEMICOLON as TokenType) ||
    p.check(TokenTypes.RBRACE as TokenType) ||
    p.check(TokenTypes.PIPE as TokenType) ||
    p.check(TokenTypes.GT as TokenType) ||
    p.check(TokenTypes.APPEND as TokenType)
  ) {
    args.push({ type: "field", index: { type: "number", value: 0 } });
  } else {
    // Parse print arguments - use parsePrintArg to stop before > and >>
    // In AWK, > and >> at print level are redirection, not comparison
    args.push(parsePrintArg(p));
    while (p.check(TokenTypes.COMMA as TokenType)) {
      p.advance();
      args.push(parsePrintArg(p));
    }
  }

  // Check for output redirection
  let output: { redirect: ">" | ">>"; file: AwkExpr } | undefined;
  if (p.check(TokenTypes.GT as TokenType)) {
    p.advance();
    output = { redirect: ">", file: p.parsePrimary() };
  } else if (p.check(TokenTypes.APPEND as TokenType)) {
    p.advance();
    output = { redirect: ">>", file: p.parsePrimary() };
  }

  return { type: "print", args, output };
}

/**
 * Parse a print argument - same as expression but treats > and >> at the TOP LEVEL
 * (not inside ternary) as redirection rather than comparison operators.
 * Supports assignment expressions like: print 9, a=10, 11
 */
function parsePrintArg(p: PrintParserContext): AwkExpr {
  // For ternary conditions, we need to allow > as comparison
  // Check if there's a ? ahead (indicating ternary) - if so, parse full comparison
  const hasTernary = lookAheadForTernary(p);

  if (hasTernary) {
    // Parse as full ternary with regular comparison (> allowed)
    // Use parsePrintAssignment to support assignment in ternary context
    return parsePrintAssignment(p, true);
  }

  // No ternary - parse without > to leave room for redirection
  return parsePrintAssignment(p, false);
}

/**
 * Parse assignment in print context. Supports a=10, a+=5, etc.
 * @param allowGt Whether to allow > as comparison (true when inside ternary)
 */
function parsePrintAssignment(
  p: PrintParserContext,
  allowGt: boolean
): AwkExpr {
  const expr = allowGt ? p.parseTernary() : parsePrintOr(p);

  if (
    p.match(
      TokenTypes.ASSIGN as TokenType,
      TokenTypes.PLUS_ASSIGN as TokenType,
      TokenTypes.MINUS_ASSIGN as TokenType,
      TokenTypes.STAR_ASSIGN as TokenType,
      TokenTypes.SLASH_ASSIGN as TokenType,
      TokenTypes.PERCENT_ASSIGN as TokenType,
      TokenTypes.CARET_ASSIGN as TokenType
    )
  ) {
    const opToken = p.advance();
    const value = parsePrintAssignment(p, allowGt);

    if (
      expr.type !== "variable" &&
      expr.type !== "field" &&
      expr.type !== "array_access"
    ) {
      throw new Error("Invalid assignment target");
    }

    const opMap = new Map<
      string,
      "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^="
    >([
      ["=", "="],
      ["+=", "+="],
      ["-=", "-="],
      ["*=", "*="],
      ["/=", "/="],
      ["%=", "%="],
      ["^=", "^="]
    ]);

    return {
      type: "assignment",
      operator: opMap.get(opToken.value as string) ?? "=",
      target: expr as AwkVariable | AwkFieldRef | AwkArrayAccess,
      value
    };
  }

  return expr;
}

/**
 * Look ahead to see if there's a ternary ? operator before the next statement terminator.
 * This tells us whether > is comparison (in ternary condition) or redirection.
 */
function lookAheadForTernary(p: PrintParserContext): boolean {
  let depth = 0;
  let i = p.pos;

  while (i < p.tokens.length) {
    const token = p.tokens[i];

    // Track parentheses depth
    if (token.type === (TokenTypes.LPAREN as TokenType)) depth++;
    if (token.type === (TokenTypes.RPAREN as TokenType)) depth--;

    // Found ? at top level - it's a ternary (even if > came before)
    if (token.type === (TokenTypes.QUESTION as TokenType) && depth === 0) {
      return true;
    }

    // Statement terminators - stop looking (no ternary found)
    if (
      token.type === (TokenTypes.NEWLINE as TokenType) ||
      token.type === (TokenTypes.SEMICOLON as TokenType) ||
      token.type === (TokenTypes.RBRACE as TokenType) ||
      token.type === (TokenTypes.COMMA as TokenType) ||
      token.type === (TokenTypes.PIPE as TokenType)
    ) {
      return false;
    }

    i++;
  }

  return false;
}

function parsePrintOr(p: PrintParserContext): AwkExpr {
  let left = parsePrintAnd(p);
  while (p.check(TokenTypes.OR as TokenType)) {
    p.advance();
    const right = parsePrintAnd(p);
    left = { type: "binary", operator: "||", left, right };
  }
  return left;
}

function parsePrintAnd(p: PrintParserContext): AwkExpr {
  let left = parsePrintIn(p);
  while (p.check(TokenTypes.AND as TokenType)) {
    p.advance();
    const right = parsePrintIn(p);
    left = { type: "binary", operator: "&&", left, right };
  }
  return left;
}

function parsePrintIn(p: PrintParserContext): AwkExpr {
  const left = parsePrintConcatenation(p);

  if (p.check(TokenTypes.IN as TokenType)) {
    p.advance();
    const arrayName = String(p.expect(TokenTypes.IDENT as TokenType).value);
    return { type: "in", key: left, array: arrayName };
  }

  return left;
}

function parsePrintConcatenation(p: PrintParserContext): AwkExpr {
  let left = parsePrintMatch(p);

  // Concatenation is implicit - consecutive expressions without operators
  // For print context, also stop at > and >> (redirection)
  while (canStartExpression(p) && !isPrintConcatTerminator(p)) {
    const right = parsePrintMatch(p);
    left = { type: "binary", operator: " ", left, right };
  }

  return left;
}

function parsePrintMatch(p: PrintParserContext): AwkExpr {
  let left = parsePrintComparison(p);

  while (
    p.match(TokenTypes.MATCH as TokenType, TokenTypes.NOT_MATCH as TokenType)
  ) {
    const op =
      p.advance().type === (TokenTypes.MATCH as TokenType) ? "~" : "!~";
    const right = parsePrintComparison(p);
    left = { type: "binary", operator: op, left, right };
  }

  return left;
}

/**
 * Like parseComparison but doesn't consume > and >> (for print redirection)
 */
function parsePrintComparison(p: PrintParserContext): AwkExpr {
  let left = p.parseAddSub();

  // Only handle <, <=, >=, ==, != - NOT > or >> (those are redirection)
  while (
    p.match(
      TokenTypes.LT as TokenType,
      TokenTypes.LE as TokenType,
      TokenTypes.GE as TokenType,
      TokenTypes.EQ as TokenType,
      TokenTypes.NE as TokenType
    )
  ) {
    const opToken = p.advance();
    const right = p.parseAddSub();
    const opMap = new Map<string, "<" | "<=" | ">=" | "==" | "!=">([
      ["<", "<"],
      ["<=", "<="],
      [">=", ">="],
      ["==", "=="],
      ["!=", "!="]
    ]);
    left = {
      type: "binary",
      operator: opMap.get(opToken.value as string) ?? "==",
      left,
      right
    };
  }

  return left;
}

function canStartExpression(p: PrintParserContext): boolean {
  return p.match(
    TokenTypes.NUMBER as TokenType,
    TokenTypes.STRING as TokenType,
    TokenTypes.IDENT as TokenType,
    TokenTypes.DOLLAR as TokenType,
    TokenTypes.LPAREN as TokenType,
    TokenTypes.NOT as TokenType,
    TokenTypes.MINUS as TokenType,
    TokenTypes.PLUS as TokenType,
    TokenTypes.INCREMENT as TokenType,
    TokenTypes.DECREMENT as TokenType
  );
}

/**
 * Check if the current token terminates concatenation in print context.
 * Similar to isConcatTerminator but also includes > for redirection.
 */
function isPrintConcatTerminator(p: PrintParserContext): boolean {
  return p.match(
    // Logical operators
    TokenTypes.AND as TokenType,
    TokenTypes.OR as TokenType,
    TokenTypes.QUESTION as TokenType,
    // Assignment operators
    TokenTypes.ASSIGN as TokenType,
    TokenTypes.PLUS_ASSIGN as TokenType,
    TokenTypes.MINUS_ASSIGN as TokenType,
    TokenTypes.STAR_ASSIGN as TokenType,
    TokenTypes.SLASH_ASSIGN as TokenType,
    TokenTypes.PERCENT_ASSIGN as TokenType,
    TokenTypes.CARET_ASSIGN as TokenType,
    // Expression terminators
    TokenTypes.COMMA as TokenType,
    TokenTypes.SEMICOLON as TokenType,
    TokenTypes.NEWLINE as TokenType,
    TokenTypes.RBRACE as TokenType,
    TokenTypes.RPAREN as TokenType,
    TokenTypes.RBRACKET as TokenType,
    TokenTypes.COLON as TokenType,
    // Redirection (print-specific)
    TokenTypes.PIPE as TokenType,
    TokenTypes.APPEND as TokenType,
    TokenTypes.GT as TokenType, // > is redirection in print context
    // Array membership
    TokenTypes.IN as TokenType
  );
}

/**
 * Parse a printf statement.
 */
export function parsePrintfStatement(p: PrintParserContext): AwkStmt {
  p.expect(TokenTypes.PRINTF as TokenType);

  // AWK supports both:
  //   printf format, arg1, arg2
  //   printf(format, arg1, arg2)
  // In the parenthesized form, commas are argument separators, NOT the comma operator

  const hasParens = p.check(TokenTypes.LPAREN as TokenType);
  if (hasParens) {
    p.advance(); // consume (
    // Skip newlines after opening paren (AWK allows multi-line printf)
    p.skipNewlines();
  }

  // Use parsePrintArg to stop at > and >> (for redirection) when not in parens
  // When in parens, we use parseExpression for each argument (stops at , and ))
  const format = hasParens ? p.parseExpression() : parsePrintArg(p);
  const args: AwkExpr[] = [];

  while (p.check(TokenTypes.COMMA as TokenType)) {
    p.advance();
    // Skip newlines after comma (AWK allows multi-line printf)
    if (hasParens) {
      p.skipNewlines();
    }
    args.push(hasParens ? p.parseExpression() : parsePrintArg(p));
  }

  if (hasParens) {
    // Skip newlines before closing paren
    p.skipNewlines();
    p.expect(TokenTypes.RPAREN as TokenType);
  }

  // Check for output redirection
  let output: { redirect: ">" | ">>"; file: AwkExpr } | undefined;
  if (p.check(TokenTypes.GT as TokenType)) {
    p.advance();
    output = { redirect: ">", file: p.parsePrimary() };
  } else if (p.check(TokenTypes.APPEND as TokenType)) {
    p.advance();
    output = { redirect: ">>", file: p.parsePrimary() };
  }

  return { type: "printf", format, args, output };
}
