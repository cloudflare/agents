/**
 * Command Parser
 *
 * Handles parsing of simple commands, redirections, and assignments.
 */

import {
  AST,
  type AssignmentNode,
  type RedirectionNode,
  type RedirectionOperator,
  type SimpleCommandNode,
  type WordNode
} from "../ast/types";
import { TokenType } from "./lexer";
import type { Parser } from "./parser";
import {
  REDIRECTION_AFTER_FD_VARIABLE,
  REDIRECTION_AFTER_NUMBER,
  REDIRECTION_TOKENS
} from "./types";
import * as WordParser from "./word-parser";

export function isRedirection(p: Parser): boolean {
  const currentToken = p.current();
  const t = currentToken.type;

  // Check for number followed by redirection operator
  // Only treat as fd redirection if the number is immediately adjacent to the operator
  if (t === TokenType.NUMBER) {
    const nextToken = p.peek(1);
    // Check if tokens are adjacent (no space between them)
    if (currentToken.end !== nextToken.start) {
      return false;
    }
    return REDIRECTION_AFTER_NUMBER.has(nextToken.type);
  }

  // Check for FD variable followed by redirection operator
  // e.g., {fd}>file allocates an FD and stores it in variable
  if (t === TokenType.FD_VARIABLE) {
    const nextToken = p.peek(1);
    return REDIRECTION_AFTER_FD_VARIABLE.has(nextToken.type);
  }

  return REDIRECTION_TOKENS.has(t);
}

export function parseRedirection(p: Parser): RedirectionNode {
  let fd: number | null = null;
  let fdVariable: string | undefined;

  // Parse optional file descriptor number
  if (p.check(TokenType.NUMBER)) {
    fd = Number.parseInt(p.advance().value, 10);
  }
  // Parse FD variable syntax: {varname}>file
  else if (p.check(TokenType.FD_VARIABLE)) {
    fdVariable = p.advance().value;
  }

  // Parse operator
  const opToken = p.advance();
  const operator = WordParser.tokenToRedirectOp(p, opToken.type);

  // Handle here-documents
  if (
    opToken.type === TokenType.DLESS ||
    opToken.type === TokenType.DLESSDASH
  ) {
    return parseHeredocStart(
      p,
      operator,
      fd,
      opToken.type === TokenType.DLESSDASH
    );
  }

  // Parse target
  if (!p.isWord()) {
    p.error("Expected redirection target");
  }

  const target = p.parseWord();
  return AST.redirection(operator, target, fd, fdVariable);
}

function parseHeredocStart(
  p: Parser,
  _operator: RedirectionOperator,
  fd: number | null,
  stripTabs: boolean
): RedirectionNode {
  // Parse delimiter
  if (!p.isWord()) {
    p.error("Expected here-document delimiter");
  }

  const delimToken = p.advance();
  let delimiter = delimToken.value;
  const quoted = delimToken.quoted || false;

  // Remove quotes from delimiter
  if (delimiter.startsWith("'") && delimiter.endsWith("'")) {
    delimiter = delimiter.slice(1, -1);
  } else if (delimiter.startsWith('"') && delimiter.endsWith('"')) {
    delimiter = delimiter.slice(1, -1);
  }

  // Create placeholder redirection
  const redirect = AST.redirection(
    stripTabs ? "<<-" : "<<", // Use proper here-doc operator
    AST.hereDoc(delimiter, AST.word([]), stripTabs, quoted),
    fd
  );

  // Register pending here-document
  p.addPendingHeredoc(redirect, delimiter, stripTabs, quoted);

  return redirect;
}

export function parseSimpleCommand(p: Parser): SimpleCommandNode {
  // Capture line number at the start of the command for $LINENO
  const startLine = p.current().line;

  const assignments: AssignmentNode[] = [];
  let name: WordNode | null = null;
  const args: WordNode[] = [];
  const redirections: RedirectionNode[] = [];

  // Parse prefix assignments and redirections (they can be interleaved)
  // e.g., FOO=foo >file BAR=bar cmd
  while (p.check(TokenType.ASSIGNMENT_WORD) || isRedirection(p)) {
    p.checkIterationLimit();
    if (p.check(TokenType.ASSIGNMENT_WORD)) {
      assignments.push(parseAssignment(p));
    } else {
      redirections.push(parseRedirection(p));
    }
  }

  // Parse command name
  if (p.isWord()) {
    name = p.parseWord();
  } else if (
    assignments.length > 0 &&
    (p.check(TokenType.DBRACK_START) || p.check(TokenType.DPAREN_START))
  ) {
    // When we have prefix assignments (e.g., FOO=bar [[ ... ]]), compound command
    // keywords are NOT recognized as keywords - they're treated as command names.
    // In bash, this results in "command not found" because [[ and (( are looked up
    // as regular commands (not special shell keywords).
    const token = p.advance();
    name = AST.word([AST.literal(token.value)]);
  }

  // Parse arguments and redirections
  // RBRACE (}) can be an argument in command position (e.g., "echo }"), so we handle it specially.
  // The loop stops on statement-end tokens EXCEPT RBRACE when we're in argument position.
  while (
    (!p.isStatementEnd() || p.check(TokenType.RBRACE)) &&
    !p.check(TokenType.PIPE, TokenType.PIPE_AMP)
  ) {
    p.checkIterationLimit();

    if (isRedirection(p)) {
      redirections.push(parseRedirection(p));
    } else if (p.check(TokenType.RBRACE)) {
      // } can be an argument like "echo }" - parse it as a word
      const token = p.advance();
      args.push(p.parseWordFromString(token.value, false, false));
    } else if (p.check(TokenType.LBRACE)) {
      // { can be an argument like "type -t {" - parse it as a word
      const token = p.advance();
      args.push(p.parseWordFromString(token.value, false, false));
    } else if (p.check(TokenType.DBRACK_END)) {
      // ]] can be an argument when [[ is parsed as a regular command
      // (e.g., FOO=bar [[ foo == foo ]] where [[ is not recognized as keyword)
      const token = p.advance();
      args.push(p.parseWordFromString(token.value, false, false));
    } else if (p.isWord()) {
      args.push(p.parseWord());
    } else if (p.check(TokenType.ASSIGNMENT_WORD)) {
      // Assignment words after command name are treated as arguments
      // (for local, export, declare, etc.)
      const token = p.advance();
      const tokenValue = token.value;

      // Check if this is an array assignment: name=( or name=(
      const endsWithEq = tokenValue.endsWith("=");
      const endsWithEqParen = tokenValue.endsWith("=(");

      if (
        (endsWithEq || endsWithEqParen) &&
        (endsWithEqParen || p.check(TokenType.LPAREN))
      ) {
        // Parse as array assignment for declare/local/export/typeset/readonly
        const baseName = endsWithEqParen
          ? tokenValue.slice(0, -2)
          : tokenValue.slice(0, -1);
        if (!endsWithEqParen) {
          p.expect(TokenType.LPAREN);
        }
        const elements = parseArrayElements(p);
        p.expect(TokenType.RPAREN);

        // Build the array assignment string: name=(elem1 elem2 ...)
        const elemStrings = elements.map((e) => WordParser.wordToString(p, e));
        const arrayStr = `${baseName}=(${elemStrings.join(" ")})`;
        args.push(p.parseWordFromString(arrayStr, false, false));
      } else {
        args.push(
          p.parseWordFromString(tokenValue, token.quoted, token.singleQuoted)
        );
      }
    } else if (p.check(TokenType.LPAREN)) {
      // Bare ( in argument position is a syntax error (e.g., "echo a(b)")
      p.error(`syntax error near unexpected token \`('`);
    } else {
      break;
    }
  }

  const node = AST.simpleCommand(name, args, assignments, redirections);
  node.line = startLine;
  return node;
}

function parseAssignment(p: Parser): AssignmentNode {
  const token = p.expect(TokenType.ASSIGNMENT_WORD);
  const value = token.value;

  // Parse VAR=value, VAR+=value, or VAR[subscript]=value, VAR[subscript]+=value
  // Handle nested brackets in subscript: a[a[0]]=value
  const nameMatch = value.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!nameMatch) {
    p.error(`Invalid assignment: ${value}`);
  }

  const name = nameMatch[0];
  let subscript: string | undefined;
  let pos = name.length;

  // Check for array subscript with nested brackets
  if (value[pos] === "[") {
    let depth = 0;
    const subscriptStart = pos + 1;
    for (; pos < value.length; pos++) {
      if (value[pos] === "[") depth++;
      else if (value[pos] === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      p.error(`Invalid assignment: ${value}`);
    }
    subscript = value.slice(subscriptStart, pos);
    pos++; // skip closing ]
  }

  // Check for += or =
  const append = value[pos] === "+";
  if (append) pos++;
  if (value[pos] !== "=") {
    p.error(`Invalid assignment: ${value}`);
  }
  pos++; // skip =

  const valueStr = value.slice(pos);

  // Check for array assignment: VAR=(...)
  // The '(' can be part of the token (valueStr === "(") or a separate token
  // but only if it's immediately adjacent (no space between = and ()
  // Array assignment to subscripted element is not allowed: a[0]=(1 2) is invalid
  // But we parse it anyway and handle the error at runtime (bash behavior)
  if (valueStr === "(") {
    const elements = parseArrayElements(p);
    p.expect(TokenType.RPAREN);
    // If subscript is defined, include it in name so runtime can detect the error
    const assignName = subscript !== undefined ? `${name}[${subscript}]` : name;
    return AST.assignment(assignName, null, append, elements);
  }

  // Check for adjacent LPAREN: a=() with no space
  if (valueStr === "" && p.check(TokenType.LPAREN)) {
    const currentToken = p.current();
    // Only allow if LPAREN is immediately after the assignment word (token.end === lparen.start)
    if (token.end === currentToken.start) {
      p.advance(); // consume LPAREN
      const elements = parseArrayElements(p);
      p.expect(TokenType.RPAREN);
      // If subscript is defined, include it in name so runtime can detect the error
      const assignName =
        subscript !== undefined ? `${name}[${subscript}]` : name;
      return AST.assignment(assignName, null, append, elements);
    }
    // Space between = and ( is a syntax error - let the parser handle it
  }

  // Regular assignment (may include subscript)
  // Pass through the quoting info from the token so tilde expansion is properly suppressed
  // isAssignment=true allows tilde expansion after : (for PATH-like assignments)
  const wordValue = valueStr
    ? p.parseWordFromString(valueStr, token.quoted, token.singleQuoted, true)
    : null;

  // If we have a subscript, embed it in the name (e.g., "a[0]")
  // The interpreter will parse this out
  const assignName = subscript !== undefined ? `${name}[${subscript}]` : name;

  return AST.assignment(assignName, wordValue, append, null);
}

// Tokens that are invalid inside array literals
const INVALID_ARRAY_TOKENS: Set<TokenType> = new Set([
  TokenType.AMP, // &
  TokenType.PIPE, // |
  TokenType.PIPE_AMP, // |&
  TokenType.SEMICOLON, // ;
  TokenType.AND_AND, // &&
  TokenType.OR_OR, // ||
  TokenType.DSEMI, // ;;
  TokenType.SEMI_AND, // ;&
  TokenType.SEMI_SEMI_AND // ;;&
]);

function parseArrayElements(p: Parser): WordNode[] {
  const elements: WordNode[] = [];
  p.skipNewlines();

  while (!p.check(TokenType.RPAREN, TokenType.EOF)) {
    p.checkIterationLimit();
    if (p.isWord()) {
      elements.push(p.parseWord());
    } else if (INVALID_ARRAY_TOKENS.has(p.current().type)) {
      // Invalid tokens inside array literals - throw syntax error
      p.error(`syntax error near unexpected token \`${p.current().value}'`);
    } else {
      // Skip other unexpected tokens to prevent infinite loop
      // This handles cases like nested parens: a=( (1 2) )
      p.advance();
    }
    p.skipNewlines();
  }

  return elements;
}
