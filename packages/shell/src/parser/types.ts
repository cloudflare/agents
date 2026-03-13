/**
 * Parser Types and Constants
 *
 * Shared types, interfaces, and constants used across parser modules.
 */

import { type Token, TokenType } from "./lexer";

// Parser limits to prevent hangs and resource exhaustion
export const MAX_INPUT_SIZE = 1_000_000; // 1MB max input
export const MAX_TOKENS = 100_000; // Max tokens to parse
export const MAX_PARSE_ITERATIONS = 1_000_000; // Max iterations in parsing loops
export const MAX_PARSER_DEPTH = 200; // Max recursion depth for nested constructs

// Pre-computed Sets for fast redirection token lookup (avoids array allocation per call)
export const REDIRECTION_TOKENS: Set<TokenType> = new Set([
  TokenType.LESS,
  TokenType.GREAT,
  TokenType.DLESS,
  TokenType.DGREAT,
  TokenType.LESSAND,
  TokenType.GREATAND,
  TokenType.LESSGREAT,
  TokenType.DLESSDASH,
  TokenType.CLOBBER,
  TokenType.TLESS,
  TokenType.AND_GREAT,
  TokenType.AND_DGREAT
]);

export const REDIRECTION_AFTER_NUMBER: Set<TokenType> = new Set([
  TokenType.LESS,
  TokenType.GREAT,
  TokenType.DLESS,
  TokenType.DGREAT,
  TokenType.LESSAND,
  TokenType.GREATAND,
  TokenType.LESSGREAT,
  TokenType.DLESSDASH,
  TokenType.CLOBBER,
  TokenType.TLESS
]);

// Redirect operators that can follow {varname} (FD variable syntax)
export const REDIRECTION_AFTER_FD_VARIABLE: Set<TokenType> = new Set([
  TokenType.LESS,
  TokenType.GREAT,
  TokenType.DLESS,
  TokenType.DGREAT,
  TokenType.LESSAND,
  TokenType.GREATAND,
  TokenType.LESSGREAT,
  TokenType.DLESSDASH,
  TokenType.CLOBBER,
  TokenType.TLESS,
  TokenType.AND_GREAT,
  TokenType.AND_DGREAT
]);

export interface ParseError {
  message: string;
  line: number;
  column: number;
  token?: Token;
}

export class ParseException extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number,
    public token: Token | undefined = undefined
  ) {
    super(`Parse error at ${line}:${column}: ${message}`);
    this.name = "ParseException";
  }
}
