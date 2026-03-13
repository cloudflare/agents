/**
 * Compound Command Parser
 *
 * Handles parsing of compound commands: if, for, while, until, case, subshell, group.
 */

import {
  type ArithmeticExpressionNode,
  AST,
  type CaseItemNode,
  type CaseNode,
  type CStyleForNode,
  type ForNode,
  type GroupNode,
  type IfClause,
  type IfNode,
  type StatementNode,
  type SubshellNode,
  type UntilNode,
  type WhileNode,
  type WordNode
} from "../ast/types";
import * as ArithParser from "./arithmetic-parser";
import { TokenType } from "./lexer";
import type { Parser } from "./parser";

export function parseIf(
  p: Parser,
  options?: { skipRedirections?: boolean }
): IfNode {
  p.expect(TokenType.IF);
  const clauses: IfClause[] = [];

  // Parse if condition
  const condition = p.parseCompoundList();
  p.expect(TokenType.THEN);
  const body = p.parseCompoundList();
  // Empty body is a syntax error in bash
  if (body.length === 0) {
    const nextTok = p.check(TokenType.FI)
      ? "fi"
      : p.check(TokenType.ELSE)
        ? "else"
        : p.check(TokenType.ELIF)
          ? "elif"
          : "fi";
    p.error(`syntax error near unexpected token \`${nextTok}'`);
  }
  clauses.push({ condition, body });

  // Parse elif clauses
  while (p.check(TokenType.ELIF)) {
    p.advance();
    const elifCondition = p.parseCompoundList();
    p.expect(TokenType.THEN);
    const elifBody = p.parseCompoundList();
    // Empty elif body is a syntax error
    if (elifBody.length === 0) {
      const nextTok = p.check(TokenType.FI)
        ? "fi"
        : p.check(TokenType.ELSE)
          ? "else"
          : p.check(TokenType.ELIF)
            ? "elif"
            : "fi";
      p.error(`syntax error near unexpected token \`${nextTok}'`);
    }
    clauses.push({ condition: elifCondition, body: elifBody });
  }

  // Parse else clause
  let elseBody: StatementNode[] | null = null;
  if (p.check(TokenType.ELSE)) {
    p.advance();
    elseBody = p.parseCompoundList();
    // Empty else body is a syntax error
    if (elseBody.length === 0) {
      p.error("syntax error near unexpected token `fi'");
    }
  }

  p.expect(TokenType.FI);

  // Parse optional redirections (unless skipped for function body)
  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.ifNode(clauses, elseBody, redirections);
}

export function parseFor(
  p: Parser,
  options?: { skipRedirections?: boolean }
): ForNode | CStyleForNode {
  const forToken = p.expect(TokenType.FOR);

  // Check for C-style for: for (( ... ))
  if (p.check(TokenType.DPAREN_START)) {
    return parseCStyleFor(p, options, forToken.line);
  }

  // Regular for: for VAR in WORDS
  // The variable can be NAME, IN, or even invalid names like "i.j"
  // Invalid names are validated at runtime to match bash behavior
  if (!p.isWord()) {
    p.error("Expected variable name in for loop");
  }
  const varToken = p.advance();
  const variable = varToken.value;

  let words: WordNode[] | null = null;

  // Check for 'in' keyword
  p.skipNewlines();
  if (p.check(TokenType.IN)) {
    p.advance();
    words = [];

    // Parse words until ; or newline
    while (
      !p.check(
        TokenType.SEMICOLON,
        TokenType.NEWLINE,
        TokenType.DO,
        TokenType.EOF
      )
    ) {
      if (p.isWord()) {
        words.push(p.parseWord());
      } else {
        break;
      }
    }
  }

  // Skip separator
  if (p.check(TokenType.SEMICOLON)) {
    p.advance();
  }
  p.skipNewlines();

  p.expect(TokenType.DO);
  const body = p.parseCompoundList();
  p.expect(TokenType.DONE);

  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.forNode(variable, words, body, redirections);
}

function parseCStyleFor(
  p: Parser,
  options?: { skipRedirections?: boolean },
  startLine?: number
): CStyleForNode {
  p.expect(TokenType.DPAREN_START);

  // Parse init; cond; step
  // This is a simplified parser - we read until ; or ))
  let init: ArithmeticExpressionNode | null = null;
  let condition: ArithmeticExpressionNode | null = null;
  let update: ArithmeticExpressionNode | null = null;

  const parts: string[] = ["", "", ""];
  let partIdx = 0;
  let depth = 0;

  // Read until ))
  while (!p.check(TokenType.DPAREN_END, TokenType.EOF)) {
    const token = p.advance();
    if (token.type === TokenType.SEMICOLON && depth === 0) {
      partIdx++;
      if (partIdx > 2) break;
    } else {
      if (token.value === "(") depth++;
      if (token.value === ")") depth--;
      parts[partIdx] += token.value;
    }
  }

  p.expect(TokenType.DPAREN_END);

  if (parts[0].trim()) {
    init = ArithParser.parseArithmeticExpression(p, parts[0].trim());
  }
  if (parts[1].trim()) {
    condition = ArithParser.parseArithmeticExpression(p, parts[1].trim());
  }
  if (parts[2].trim()) {
    update = ArithParser.parseArithmeticExpression(p, parts[2].trim());
  }

  p.skipNewlines();
  if (p.check(TokenType.SEMICOLON)) {
    p.advance();
  }
  p.skipNewlines();

  // Accept either do...done or { } for body (bash allows both)
  let body: ReturnType<typeof p.parseCompoundList>;
  if (p.check(TokenType.LBRACE)) {
    p.advance();
    body = p.parseCompoundList();
    p.expect(TokenType.RBRACE);
  } else {
    p.expect(TokenType.DO);
    body = p.parseCompoundList();
    p.expect(TokenType.DONE);
  }

  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return {
    type: "CStyleFor",
    init,
    condition,
    update,
    body,
    redirections,
    line: startLine
  };
}

export function parseWhile(
  p: Parser,
  options?: { skipRedirections?: boolean }
): WhileNode {
  p.expect(TokenType.WHILE);
  const condition = p.parseCompoundList();
  p.expect(TokenType.DO);
  const body = p.parseCompoundList();
  // Empty body is a syntax error in bash
  if (body.length === 0) {
    p.error("syntax error near unexpected token `done'");
  }
  p.expect(TokenType.DONE);

  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.whileNode(condition, body, redirections);
}

export function parseUntil(
  p: Parser,
  options?: { skipRedirections?: boolean }
): UntilNode {
  p.expect(TokenType.UNTIL);
  const condition = p.parseCompoundList();
  p.expect(TokenType.DO);
  const body = p.parseCompoundList();
  // Empty body is a syntax error in bash
  if (body.length === 0) {
    p.error("syntax error near unexpected token `done'");
  }
  p.expect(TokenType.DONE);

  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.untilNode(condition, body, redirections);
}

export function parseCase(
  p: Parser,
  options?: { skipRedirections?: boolean }
): CaseNode {
  p.expect(TokenType.CASE);

  if (!p.isWord()) {
    p.error("Expected word after 'case'");
  }
  const word = p.parseWord();

  p.skipNewlines();
  p.expect(TokenType.IN);
  p.skipNewlines();

  const items: CaseItemNode[] = [];

  // Parse case items
  while (!p.check(TokenType.ESAC, TokenType.EOF)) {
    p.checkIterationLimit();
    const posBefore = p.getPos();

    const item = parseCaseItem(p);
    if (item) {
      items.push(item);
    }
    p.skipNewlines();

    // Safety: if we didn't advance and didn't get an item, break to prevent infinite loop
    if (p.getPos() === posBefore && !item) {
      break;
    }
  }

  p.expect(TokenType.ESAC);

  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.caseNode(word, items, redirections);
}

function parseCaseItem(p: Parser): CaseItemNode | null {
  // Skip optional (
  if (p.check(TokenType.LPAREN)) {
    p.advance();
  }

  const patterns: WordNode[] = [];

  // Parse patterns separated by |
  while (p.isWord()) {
    patterns.push(p.parseWord());

    if (p.check(TokenType.PIPE)) {
      p.advance();
    } else {
      break;
    }
  }

  if (patterns.length === 0) {
    return null;
  }

  // Expect )
  p.expect(TokenType.RPAREN);
  p.skipNewlines();

  // Parse body
  const body: StatementNode[] = [];
  while (
    !p.check(
      TokenType.DSEMI,
      TokenType.SEMI_AND,
      TokenType.SEMI_SEMI_AND,
      TokenType.ESAC,
      TokenType.EOF
    )
  ) {
    p.checkIterationLimit();

    // Check if we're looking at the start of another case pattern (word followed by ))
    // This handles the syntax error case of empty actions like: a) b) echo A ;;
    if (p.isWord() && p.peek(1).type === TokenType.RPAREN) {
      // This looks like another case pattern starting without a terminator
      // This is a syntax error in bash
      p.error(`syntax error near unexpected token \`)'`);
    }
    // Also check for optional ( before pattern
    if (p.check(TokenType.LPAREN) && p.peek(1).type === TokenType.WORD) {
      p.error(`syntax error near unexpected token \`${p.peek(1).value}'`);
    }

    const posBefore = p.getPos();
    const stmt = p.parseStatement();
    if (stmt) {
      body.push(stmt);
    }
    // Don't skip case terminators (;;, ;&, ;;&) - we need to see them
    p.skipSeparators(false);

    // If we didn't advance and didn't get a statement, break to avoid infinite loop
    if (p.getPos() === posBefore && !stmt) {
      break;
    }
  }

  // Parse terminator
  let terminator: ";;" | ";&" | ";;&" = ";;";
  if (p.check(TokenType.DSEMI)) {
    p.advance();
    terminator = ";;";
  } else if (p.check(TokenType.SEMI_AND)) {
    p.advance();
    terminator = ";&";
  } else if (p.check(TokenType.SEMI_SEMI_AND)) {
    p.advance();
    terminator = ";;&";
  }

  return AST.caseItem(patterns, body, terminator);
}

export function parseSubshell(
  p: Parser,
  options?: { skipRedirections?: boolean }
): SubshellNode | CStyleForNode {
  p.expect(TokenType.LPAREN);

  const body = p.parseCompoundList();
  p.expect(TokenType.RPAREN);

  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.subshell(body, redirections);
}

export function parseGroup(
  p: Parser,
  options?: { skipRedirections?: boolean }
): GroupNode {
  p.expect(TokenType.LBRACE);
  const body = p.parseCompoundList();
  p.expect(TokenType.RBRACE);

  // For function bodies, redirections are parsed by the function definition, not the group
  const redirections = options?.skipRedirections
    ? []
    : p.parseOptionalRedirections();

  return AST.group(body, redirections);
}
