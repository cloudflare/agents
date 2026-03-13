/**
 * Lexer for Bash Scripts
 *
 * The lexer tokenizes input into a stream of tokens that the parser consumes.
 * It handles:
 * - Operators and delimiters
 * - Words (with quoting rules)
 * - Comments
 * - Here-documents
 * - Escape sequences
 */

// Default max heredoc size to prevent memory exhaustion (10MB)
const DEFAULT_MAX_HEREDOC_SIZE = 10_485_760;

export interface LexerOptions {
  /** Maximum heredoc size in bytes (default: 10MB) */
  maxHeredocSize?: number;
}

export enum TokenType {
  // End of input
  EOF = "EOF",

  // Newlines and separators
  NEWLINE = "NEWLINE",
  SEMICOLON = "SEMICOLON",
  AMP = "AMP", // &

  // Operators
  PIPE = "PIPE", // |
  PIPE_AMP = "PIPE_AMP", // |&
  AND_AND = "AND_AND", // &&
  OR_OR = "OR_OR", // ||
  BANG = "BANG", // !

  // Redirections
  LESS = "LESS", // <
  GREAT = "GREAT", // >
  DLESS = "DLESS", // <<
  DGREAT = "DGREAT", // >>
  LESSAND = "LESSAND", // <&
  GREATAND = "GREATAND", // >&
  LESSGREAT = "LESSGREAT", // <>
  DLESSDASH = "DLESSDASH", // <<-
  CLOBBER = "CLOBBER", // >|
  TLESS = "TLESS", // <<<
  AND_GREAT = "AND_GREAT", // &>
  AND_DGREAT = "AND_DGREAT", // &>>

  // Grouping
  LPAREN = "LPAREN", // (
  RPAREN = "RPAREN", // )
  LBRACE = "LBRACE", // {
  RBRACE = "RBRACE", // }

  // Special
  DSEMI = "DSEMI", // ;;
  SEMI_AND = "SEMI_AND", // ;&
  SEMI_SEMI_AND = "SEMI_SEMI_AND", // ;;&

  // Compound commands
  DBRACK_START = "DBRACK_START", // [[
  DBRACK_END = "DBRACK_END", // ]]
  DPAREN_START = "DPAREN_START", // ((
  DPAREN_END = "DPAREN_END", // ))

  // Reserved words
  IF = "IF",
  THEN = "THEN",
  ELSE = "ELSE",
  ELIF = "ELIF",
  FI = "FI",
  FOR = "FOR",
  WHILE = "WHILE",
  UNTIL = "UNTIL",
  DO = "DO",
  DONE = "DONE",
  CASE = "CASE",
  ESAC = "ESAC",
  IN = "IN",
  FUNCTION = "FUNCTION",
  SELECT = "SELECT",
  TIME = "TIME",
  COPROC = "COPROC",

  // Words and identifiers
  WORD = "WORD",
  NAME = "NAME", // Valid variable name
  NUMBER = "NUMBER", // For redirections like 2>&1
  ASSIGNMENT_WORD = "ASSIGNMENT_WORD", // VAR=value
  FD_VARIABLE = "FD_VARIABLE", // {varname} before redirect operator

  // Comments
  COMMENT = "COMMENT",

  // Here-document content
  HEREDOC_CONTENT = "HEREDOC_CONTENT"
}

export interface Token {
  type: TokenType;
  value: string;
  /** Original position in input */
  start: number;
  end: number;
  line: number;
  column: number;
  /** For WORD tokens: quote information */
  quoted?: boolean;
  singleQuoted?: boolean;
}

/**
 * Error thrown when the lexer encounters invalid input
 */
export class LexerError extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number
  ) {
    super(`line ${line}: ${message}`);
    this.name = "LexerError";
  }
}

/**
 * Reserved words in bash
 * Using Map to prevent prototype pollution (e.g., "constructor", "__proto__")
 */
const RESERVED_WORDS = new Map<string, TokenType>([
  ["if", TokenType.IF],
  ["then", TokenType.THEN],
  ["else", TokenType.ELSE],
  ["elif", TokenType.ELIF],
  ["fi", TokenType.FI],
  ["for", TokenType.FOR],
  ["while", TokenType.WHILE],
  ["until", TokenType.UNTIL],
  ["do", TokenType.DO],
  ["done", TokenType.DONE],
  ["case", TokenType.CASE],
  ["esac", TokenType.ESAC],
  ["in", TokenType.IN],
  ["function", TokenType.FUNCTION],
  ["select", TokenType.SELECT],
  ["time", TokenType.TIME],
  ["coproc", TokenType.COPROC]
]);

/**
 * Check if a string is a valid assignment LHS with optional nested array subscript
 * Handles: VAR, a[0], a[x], a[a[0]], a[x+1], etc.
 */
function isValidAssignmentLHS(str: string): boolean {
  // Must start with valid variable name
  const match = str.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!match) return false;

  const afterName = str.slice(match[0].length);

  // If nothing after name, it's valid (simple variable)
  if (afterName === "" || afterName === "+") return true;

  // If it's an array subscript, need to check for balanced brackets
  if (afterName[0] === "[") {
    // Find matching close bracket (handling nested brackets)
    let depth = 0;
    let i = 0;
    for (; i < afterName.length; i++) {
      if (afterName[i] === "[") depth++;
      else if (afterName[i] === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Must have found closing bracket
    if (depth !== 0 || i >= afterName.length) return false;
    // After closing bracket, only + is allowed (for +=)
    const afterBracket = afterName.slice(i + 1);
    return afterBracket === "" || afterBracket === "+";
  }

  return false;
}

/**
 * Find the index of assignment '=' or '+=' outside of brackets.
 * Returns the index of '=' (or '=' after '+') or -1 if not found.
 * For 'a[x=1]=value', returns the index of the second '='.
 */
function findAssignmentEq(str: string): number {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
    } else if (depth === 0 && c === "=") {
      return i;
    } else if (depth === 0 && c === "+" && str[i + 1] === "=") {
      return i + 1; // Return position of '=' in '+='
    }
  }
  return -1;
}

/**
 * Three-character operators (simple ones without special handling)
 */
const THREE_CHAR_OPS: Array<[string, string, string, TokenType]> = [
  [";", ";", "&", TokenType.SEMI_SEMI_AND],
  ["<", "<", "<", TokenType.TLESS],
  ["&", ">", ">", TokenType.AND_DGREAT]
  // Note: <<- has special handling for heredoc, not included here
];

/**
 * Two-character operators (simple ones without special handling)
 * Note: << has special handling for heredoc, not included here
 */
const TWO_CHAR_OPS: Array<[string, string, TokenType]> = [
  ["[", "[", TokenType.DBRACK_START],
  ["]", "]", TokenType.DBRACK_END],
  ["(", "(", TokenType.DPAREN_START],
  [")", ")", TokenType.DPAREN_END],
  ["&", "&", TokenType.AND_AND],
  ["|", "|", TokenType.OR_OR],
  [";", ";", TokenType.DSEMI],
  [";", "&", TokenType.SEMI_AND],
  ["|", "&", TokenType.PIPE_AMP],
  [">", ">", TokenType.DGREAT],
  ["<", "&", TokenType.LESSAND],
  [">", "&", TokenType.GREATAND],
  ["<", ">", TokenType.LESSGREAT],
  [">", "|", TokenType.CLOBBER],
  ["&", ">", TokenType.AND_GREAT]
];

/**
 * Single-character operators (simple ones without special handling)
 * Note: {, }, ! have special handling, not included here
 */
const SINGLE_CHAR_OPS = new Map<string, TokenType>([
  ["|", TokenType.PIPE],
  ["&", TokenType.AMP],
  [";", TokenType.SEMICOLON],
  ["(", TokenType.LPAREN],
  [")", TokenType.RPAREN],
  ["<", TokenType.LESS],
  [">", TokenType.GREAT]
]);

/**
 * Check if a string is a valid variable name
 */
function isValidName(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

/**
 * Check if a character is a word boundary (ends a word token)
 */
function isWordBoundary(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === ";" ||
    char === "&" ||
    char === "|" ||
    char === "(" ||
    char === ")" ||
    char === "<" ||
    char === ">"
  );
}

/**
 * Lexer class
 */
export class Lexer {
  private input: string;
  private pos = 0;
  private line = 1;
  private column = 1;
  private tokens: Token[] = [];
  private pendingHeredocs: {
    delimiter: string;
    stripTabs: boolean;
    quoted: boolean;
  }[] = [];
  // Track depth inside (( )) for C-style for loops and arithmetic commands
  // When > 0, we're inside (( )) and need to track nested parens
  private dparenDepth = 0;
  private maxHeredocSize: number;

  constructor(input: string, options?: LexerOptions) {
    this.input = input;
    this.maxHeredocSize = options?.maxHeredocSize ?? DEFAULT_MAX_HEREDOC_SIZE;
  }

  /**
   * Tokenize the entire input
   */
  tokenize(): Token[] {
    const input = this.input;
    const len = input.length;
    const tokens = this.tokens;
    const pendingHeredocs = this.pendingHeredocs;

    while (this.pos < len) {
      // Check for pending here-documents after newline BEFORE skipping whitespace
      // to preserve leading whitespace in heredoc content
      if (
        pendingHeredocs.length > 0 &&
        tokens.length > 0 &&
        tokens[tokens.length - 1].type === TokenType.NEWLINE
      ) {
        this.readHeredocContent();
        continue;
      }

      this.skipWhitespace();

      if (this.pos >= len) break;

      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }

    // Add EOF token
    tokens.push({
      type: TokenType.EOF,
      value: "",
      start: this.pos,
      end: this.pos,
      line: this.line,
      column: this.column
    });

    return tokens;
  }

  private skipWhitespace(): void {
    const input = this.input;
    const len = input.length;
    let pos = this.pos;
    let col = this.column;
    let ln = this.line;

    while (pos < len) {
      const char = input[pos];
      if (char === " " || char === "\t") {
        pos++;
        col++;
      } else if (char === "\\" && input[pos + 1] === "\n") {
        // Line continuation
        pos += 2;
        ln++;
        col = 1;
      } else {
        break;
      }
    }

    this.pos = pos;
    this.column = col;
    this.line = ln;
  }

  private nextToken(): Token | null {
    const input = this.input;
    const pos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;
    const c0 = input[pos];
    const c1 = input[pos + 1];
    const c2 = input[pos + 2];

    // Comments - but NOT inside (( )) arithmetic context where # is part of base notation
    if (c0 === "#" && this.dparenDepth === 0) {
      return this.readComment(pos, startLine, startColumn);
    }

    // Newline
    if (c0 === "\n") {
      this.pos = pos + 1;
      this.line++;
      this.column = 1;
      return {
        type: TokenType.NEWLINE,
        value: "\n",
        start: pos,
        end: pos + 1,
        line: startLine,
        column: startColumn
      };
    }

    // Three-character operators (check longer ones first)
    // Special case: <<- (heredoc with tab stripping)
    if (c0 === "<" && c1 === "<" && c2 === "-") {
      this.pos = pos + 3;
      this.column = startColumn + 3;
      this.registerHeredocFromLookahead(true);
      return this.makeToken(
        TokenType.DLESSDASH,
        "<<-",
        pos,
        startLine,
        startColumn
      );
    }
    // Table-driven three-char operators
    for (const [first, second, third, type] of THREE_CHAR_OPS) {
      if (c0 === first && c1 === second && c2 === third) {
        this.pos = pos + 3;
        this.column = startColumn + 3;
        return this.makeToken(
          type,
          first + second + third,
          pos,
          startLine,
          startColumn
        );
      }
    }

    // Two-character operators
    // Special case: << (heredoc)
    if (c0 === "<" && c1 === "<") {
      this.pos = pos + 2;
      this.column = startColumn + 2;
      this.registerHeredocFromLookahead(false);
      return this.makeToken(TokenType.DLESS, "<<", pos, startLine, startColumn);
    }
    // Special handling for (( and )) to track nested parentheses in arithmetic contexts
    // This is needed for C-style for loops: for (( n=0; n<(3-(1)); n++ ))
    if (c0 === "(" && c1 === "(") {
      // If already inside arithmetic context, (( is just two open parens for grouping
      // Don't start a new arithmetic context
      if (this.dparenDepth > 0) {
        this.pos = pos + 1;
        this.column = startColumn + 1;
        this.dparenDepth++;
        return this.makeToken(
          TokenType.LPAREN,
          "(",
          pos,
          startLine,
          startColumn
        );
      }
      // Check if this looks like nested subshells ((cmd) || (cmd2)) vs arithmetic ((1+2))
      // Use two complementary heuristics:
      // 1. looksLikeNestedSubshells: quick check if content looks like commands
      // 2. dparenClosesWithSpacedParens: check if closes with ) ) or has || && ; operators
      // Either heuristic can identify nested subshells
      if (
        this.looksLikeNestedSubshells(pos + 2) ||
        this.dparenClosesWithSpacedParens(pos + 2)
      ) {
        // Nested subshells case: emit just one LPAREN
        this.pos = pos + 1;
        this.column = startColumn + 1;
        return this.makeToken(
          TokenType.LPAREN,
          "(",
          pos,
          startLine,
          startColumn
        );
      }
      this.pos = pos + 2;
      this.column = startColumn + 2;
      this.dparenDepth = 1; // Enter arithmetic context
      return this.makeToken(
        TokenType.DPAREN_START,
        "((",
        pos,
        startLine,
        startColumn
      );
    }
    if (c0 === ")" && c1 === ")") {
      if (this.dparenDepth === 1) {
        // Closing the outermost arithmetic context
        this.pos = pos + 2;
        this.column = startColumn + 2;
        this.dparenDepth = 0;
        return this.makeToken(
          TokenType.DPAREN_END,
          "))",
          pos,
          startLine,
          startColumn
        );
      } else if (this.dparenDepth > 1) {
        // Inside arithmetic context with nested parens - emit single RPAREN
        this.pos = pos + 1;
        this.column = startColumn + 1;
        this.dparenDepth--;
        return this.makeToken(
          TokenType.RPAREN,
          ")",
          pos,
          startLine,
          startColumn
        );
      }
      // dparenDepth === 0: not in arithmetic context
      // Emit single RPAREN, let the parser handle two )s as needed
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.RPAREN, ")", pos, startLine, startColumn);
    }

    // Table-driven two-char operators (excluding (( and )) which are handled above)
    for (const [first, second, type] of TWO_CHAR_OPS) {
      // Skip (( and )) since they're handled above with depth tracking
      if (
        (first === "(" && second === "(") ||
        (first === ")" && second === ")")
      ) {
        continue;
      }
      // Skip ;; and ;;& inside (( )) context - they're separate semicolons for C-style for
      if (
        this.dparenDepth > 0 &&
        first === ";" &&
        (type === TokenType.DSEMI ||
          type === TokenType.SEMI_AND ||
          type === TokenType.SEMI_SEMI_AND)
      ) {
        continue;
      }
      if (c0 === first && c1 === second) {
        // Special case: [[ and ]] should only be recognized as tokens when followed
        // by whitespace or at a word boundary. Otherwise, they're part of a glob pattern
        // like [[z] or []z] which are character class patterns.
        if (type === TokenType.DBRACK_START || type === TokenType.DBRACK_END) {
          const afterOp = input[pos + 2];
          // If followed by a non-boundary character, treat as word instead
          if (
            afterOp !== undefined &&
            afterOp !== " " &&
            afterOp !== "\t" &&
            afterOp !== "\n" &&
            afterOp !== ";" &&
            afterOp !== "&" &&
            afterOp !== "|" &&
            afterOp !== "(" &&
            afterOp !== ")" &&
            afterOp !== "<" &&
            afterOp !== ">"
          ) {
            // Not a word boundary - this is a glob pattern like [[z], not [[
            // Skip to word parsing below
            break;
          }
        }
        this.pos = pos + 2;
        this.column = startColumn + 2;
        return this.makeToken(
          type,
          first + second,
          pos,
          startLine,
          startColumn
        );
      }
    }

    // Single-character operators
    // Track parentheses depth when inside (( )) arithmetic context
    if (c0 === "(" && this.dparenDepth > 0) {
      this.pos = pos + 1;
      this.column = startColumn + 1;
      this.dparenDepth++;
      return this.makeToken(TokenType.LPAREN, "(", pos, startLine, startColumn);
    }
    if (c0 === ")" && this.dparenDepth > 1) {
      // Inside arithmetic context with nested parens
      this.pos = pos + 1;
      this.column = startColumn + 1;
      this.dparenDepth--;
      return this.makeToken(TokenType.RPAREN, ")", pos, startLine, startColumn);
    }
    // Table-driven simple single-char operators
    const singleCharType = SINGLE_CHAR_OPS.get(c0);
    if (singleCharType !== undefined) {
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(singleCharType, c0, pos, startLine, startColumn);
    }

    // Special cases with complex handling
    if (c0 === "{") {
      // Check for FD variable syntax: {varname} immediately followed by redirect operator
      // e.g., {fd}>file, {myvar}>>file, {fd}<&-
      const fdVarResult = this.scanFdVariable(pos);
      if (fdVarResult !== null) {
        this.pos = fdVarResult.end;
        this.column = startColumn + (fdVarResult.end - pos);
        return {
          type: TokenType.FD_VARIABLE,
          value: fdVarResult.varname,
          start: pos,
          end: fdVarResult.end,
          line: startLine,
          column: startColumn
        };
      }
      // Check for {} as a word (used in find -exec)
      if (c1 === "}") {
        this.pos = pos + 2;
        this.column = startColumn + 2;
        return {
          type: TokenType.WORD,
          value: "{}",
          start: pos,
          end: pos + 2,
          line: startLine,
          column: startColumn,
          quoted: false,
          singleQuoted: false
        };
      }
      // Check for brace expansion: {a,b} or {1..10}
      // If it's a brace expansion, read it as part of a word (including any prefix/suffix)
      const braceContent = this.scanBraceExpansion(pos);
      if (braceContent !== null) {
        // Read as a word starting from here - readWord will handle the full word
        return this.readWordWithBraceExpansion(pos, startLine, startColumn);
      }
      // Not a valid brace expansion - check if there's a matching closing brace
      // If so, treat {foo} as part of a word that may include more content
      const literalBrace = this.scanLiteralBraceWord(pos);
      if (literalBrace !== null) {
        // Read as a word including the literal brace and any suffix/additional braces
        return this.readWordWithBraceExpansion(pos, startLine, startColumn);
      }
      // In bash, { must be followed by whitespace to be a group start
      // If followed by a word character, treat as a literal word starting with {
      if (c1 !== undefined && c1 !== " " && c1 !== "\t" && c1 !== "\n") {
        return this.readWord(pos, startLine, startColumn);
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.LBRACE, "{", pos, startLine, startColumn);
    }
    if (c0 === "}") {
      // Check if } is followed by word characters - if so, it's a literal } in a word
      // e.g., echo }_{a,b} should output }_a }_b
      if (this.isWordCharFollowing(pos + 1)) {
        return this.readWord(pos, startLine, startColumn);
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.RBRACE, "}", pos, startLine, startColumn);
    }
    if (c0 === "!") {
      // Check for != operator (used in [[ ]] tests)
      if (c1 === "=") {
        this.pos = pos + 2;
        this.column = startColumn + 2;
        return this.makeToken(
          TokenType.WORD,
          "!=",
          pos,
          startLine,
          startColumn
        );
      }
      this.pos = pos + 1;
      this.column = startColumn + 1;
      return this.makeToken(TokenType.BANG, "!", pos, startLine, startColumn);
    }

    // Words
    return this.readWord(pos, startLine, startColumn);
  }

  /**
   * Look ahead from position after (( to determine if this is nested subshells
   * like ((cmd) || (cmd2)) rather than arithmetic like ((1+2)).
   *
   * Returns true if it looks like nested subshells (command invocation).
   */
  private looksLikeNestedSubshells(startPos: number): boolean {
    const input = this.input;
    const len = input.length;
    let pos = startPos;

    // Skip optional whitespace (but not newlines)
    while (pos < len && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }

    if (pos >= len) return false;

    const c = input[pos];

    // If we see another ( immediately, recursively check what's inside
    if (c === "(") {
      return this.looksLikeNestedSubshells(pos + 1);
    }

    // Check if this looks like the start of a command name
    const isLetter = /[a-zA-Z_]/.test(c);
    const isSpecialCommand = c === "!" || c === "[";

    if (!isLetter && !isSpecialCommand) {
      return false;
    }

    // Read the word-like content
    let wordEnd = pos;
    while (wordEnd < len && /[a-zA-Z0-9_\-.]/.test(input[wordEnd])) {
      wordEnd++;
    }

    if (wordEnd === pos) {
      return isSpecialCommand;
    }

    // Skip whitespace after the word (but not newlines)
    let afterWord = wordEnd;
    while (
      afterWord < len &&
      (input[afterWord] === " " || input[afterWord] === "\t")
    ) {
      afterWord++;
    }

    if (afterWord >= len) return false;

    const nextChar = input[afterWord];

    // If the word is followed by =, it's likely arithmetic
    if (nextChar === "=" && input[afterWord + 1] !== "=") {
      return false;
    }

    // If followed by newline, this is NOT a proper subshell pattern
    // like ((echo 1\necho 2\n...)) which bash treats as arithmetic error
    if (nextChar === "\n") {
      return false;
    }

    // If followed by arithmetic operators without space, likely arithmetic
    if (
      wordEnd === afterWord &&
      /[+\-*/%<>&|^!~?:]/.test(nextChar) &&
      nextChar !== "-"
    ) {
      return false;
    }

    // If followed by )), it's arithmetic
    if (nextChar === ")" && input[afterWord + 1] === ")") {
      return false;
    }

    // If followed by command-like arguments after whitespace, it's likely a command
    // But we need to verify there's a ) somewhere on this line to close the subshell
    if (
      afterWord > wordEnd &&
      (nextChar === "-" ||
        nextChar === '"' ||
        nextChar === "'" ||
        nextChar === "$" ||
        /[a-zA-Z_/.]/.test(nextChar))
    ) {
      // Scan ahead to find ) on the same line
      let scanPos = afterWord;
      while (scanPos < len && input[scanPos] !== "\n") {
        if (input[scanPos] === ")") {
          return true;
        }
        scanPos++;
      }
      // No ) found on this line - not a proper subshell
      return false;
    }

    // If followed by ) then || or &&, it's nested subshells
    if (nextChar === ")") {
      let afterParen = afterWord + 1;
      while (
        afterParen < len &&
        (input[afterParen] === " " || input[afterParen] === "\t")
      ) {
        afterParen++;
      }
      if (
        (input[afterParen] === "|" && input[afterParen + 1] === "|") ||
        (input[afterParen] === "&" && input[afterParen + 1] === "&") ||
        input[afterParen] === ";" ||
        (input[afterParen] === "|" && input[afterParen + 1] !== "|")
      ) {
        return true;
      }
    }

    return false;
  }

  private makeToken(
    type: TokenType,
    value: string,
    start: number,
    line: number,
    column: number
  ): Token {
    return {
      type,
      value,
      start,
      end: this.pos,
      line,
      column
    };
  }

  private readComment(start: number, line: number, column: number): Token {
    const input = this.input;
    const len = input.length;
    let pos = this.pos;

    // Find end of comment (newline or EOF)
    while (pos < len && input[pos] !== "\n") {
      pos++;
    }

    const value = input.slice(start, pos);
    this.pos = pos;
    this.column = column + (pos - start);

    return {
      type: TokenType.COMMENT,
      value,
      start,
      end: pos,
      line,
      column
    };
  }

  private readWord(start: number, line: number, column: number): Token {
    // Cache instance properties in locals for faster access in tight loop
    const input = this.input;
    const len = input.length;
    let pos = this.pos;

    // Fast path: scan for simple word (no quotes, escapes, or expansions)
    // This handles the majority of tokens like command names, filenames, options
    const fastStart = pos;
    while (pos < len) {
      const c = input[pos];
      // Break on any special character
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "&" ||
        c === "|" ||
        c === "(" ||
        c === ")" ||
        c === "<" ||
        c === ">" ||
        c === "'" ||
        c === '"' ||
        c === "\\" ||
        c === "$" ||
        c === "`" ||
        c === "{" ||
        c === "}" ||
        c === "~" ||
        c === "*" ||
        c === "?" ||
        c === "["
      ) {
        break;
      }
      pos++;
    }

    // If we consumed characters and hit a word boundary (not a special char needing processing)
    if (pos > fastStart) {
      const c = input[pos];
      // Check for extglob pattern: if we hit ( and previous char is extglob operator, bail to slow path
      if (c === "(" && pos > fastStart && "@*+?!".includes(input[pos - 1])) {
        // Extglob pattern - need slow path to handle it properly
        // Fall through to slow path below
      } else if (
        // If we hit end or a simple delimiter, we can use the fast path result
        pos >= len ||
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "&" ||
        c === "|" ||
        c === "(" ||
        c === ")" ||
        c === "<" ||
        c === ">"
      ) {
        const value = input.slice(fastStart, pos);
        this.pos = pos;
        this.column = column + (pos - fastStart);

        // Check for reserved words
        const reservedType = RESERVED_WORDS.get(value);
        if (reservedType !== undefined) {
          return {
            type: reservedType,
            value,
            start,
            end: pos,
            line,
            column
          };
        }

        // Check for assignment (including array subscript: a[0]=value, a[idx]=value, a[a[0]]=value, a[x=1]=value)
        const eqIdx = findAssignmentEq(value);
        if (eqIdx > 0 && isValidAssignmentLHS(value.slice(0, eqIdx))) {
          return {
            type: TokenType.ASSIGNMENT_WORD,
            value,
            start,
            end: pos,
            line,
            column
          };
        }

        // Check for number
        if (/^[0-9]+$/.test(value)) {
          return {
            type: TokenType.NUMBER,
            value,
            start,
            end: pos,
            line,
            column
          };
        }

        // Check for valid name
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
          return {
            type: TokenType.NAME,
            value,
            start,
            end: pos,
            line,
            column,
            quoted: false,
            singleQuoted: false
          };
        }

        return {
          type: TokenType.WORD,
          value,
          start,
          end: pos,
          line,
          column,
          quoted: false,
          singleQuoted: false
        };
      }
    }

    // Slow path: handle complex words with quotes, escapes, expansions
    pos = this.pos; // Reset position
    let col = this.column;
    let ln = this.line;

    let value = "";
    let quoted = false;
    let singleQuoted = false;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    // Track if the token STARTS with a quote (for assignment detection)
    // This can be set later when handling $"..." to treat it like a quoted start
    let startsWithQuote = input[pos] === '"' || input[pos] === "'";
    // Track if there's unquoted content after a quoted section (makes it partially quoted)
    let hasContentAfterQuote = false;
    // Track bracket depth for array subscripts (e.g., a[1 * 2]=x)
    // When inside brackets, spaces should NOT be treated as word boundaries
    let bracketDepth = 0;

    while (pos < len) {
      const char = input[pos];

      // Check for word boundaries
      if (!inSingleQuote && !inDoubleQuote) {
        // Check for extglob pattern: @(...), *(...), +(...), ?(...), !(...)
        // If the last character is an extglob operator and we hit (, consume the extglob group
        if (
          char === "(" &&
          value.length > 0 &&
          "@*+?!".includes(value[value.length - 1])
        ) {
          // Extglob pattern - consume the parenthesized content
          const extglobResult = this.scanExtglobPattern(pos);
          if (extglobResult !== null) {
            value += extglobResult.content;
            pos = extglobResult.end;
            col += extglobResult.content.length;
            continue;
          }
        }
        // Handle array subscript brackets - track depth for assignments like a[1 * 2]=x
        // Only start tracking when we see [ after a valid variable name pattern
        // We need to distinguish between array subscripts (a[idx]) and glob character classes (_[abc])
        // For globs, [ inside the class is literal and shouldn't increase depth
        if (char === "[" && bracketDepth === 0) {
          // Check if this looks like an array subscript (variable name followed by [)
          // A valid variable name pattern: starts with letter/underscore, followed by alphanumeric/underscore
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
            // Check if this is likely a glob character class (starts with ^ or !)
            // Glob: _[^abc], _[!abc] - negated character class
            // Array: arr[idx], arr[a[0]]
            const afterBracket = pos + 1 < len ? input[pos + 1] : "";
            if (afterBracket === "^" || afterBracket === "!") {
              // Likely a glob negated character class, don't track nested brackets
              // Just add the [ and let glob expansion handle it
              value += char;
              pos++;
              col++;
              continue;
            }
            bracketDepth = 1;
            value += char;
            pos++;
            col++;
            continue;
          }
        } else if (char === "[" && bracketDepth > 0) {
          // Nested bracket (e.g., a[a[0]]=x)
          // But skip if this [ is escaped (preceded by \)
          if (value.length > 0 && value[value.length - 1] !== "\\") {
            bracketDepth++;
          }
          value += char;
          pos++;
          col++;
          continue;
        } else if (char === "]" && bracketDepth > 0) {
          // But skip if this ] is escaped (preceded by \)
          if (value.length > 0 && value[value.length - 1] !== "\\") {
            bracketDepth--;
          }
          value += char;
          pos++;
          col++;
          continue;
        }

        // Inside brackets, only break on newlines - allow spaces and other chars
        if (bracketDepth > 0) {
          if (char === "\n") {
            break;
          }
          // Continue collecting characters inside brackets
          value += char;
          pos++;
          col++;
          continue;
        }

        if (
          char === " " ||
          char === "\t" ||
          char === "\n" ||
          char === ";" ||
          char === "&" ||
          char === "|" ||
          char === "(" ||
          char === ")" ||
          char === "<" ||
          char === ">"
        ) {
          break;
        }
      }

      // Handle $'' ANSI-C quoting (must check before regular single quotes)
      if (
        char === "$" &&
        pos + 1 < len &&
        input[pos + 1] === "'" &&
        !inSingleQuote &&
        !inDoubleQuote
      ) {
        // Include the $' in the token and process the ANSI-C string
        value += "$'";
        pos += 2;
        col += 2;
        // Read until closing quote, handling escape sequences
        while (pos < len && input[pos] !== "'") {
          if (input[pos] === "\\" && pos + 1 < len) {
            // Include the escape sequence in the token
            value += input[pos] + input[pos + 1];
            pos += 2;
            col += 2;
          } else {
            value += input[pos];
            pos++;
            col++;
          }
        }
        if (pos < len) {
          value += "'";
          pos++;
          col++;
        }
        // Don't set quoted=true - the $'...' is kept in the value and parsed specially
        continue;
      }

      // Handle $"..." locale quoting (bash extension, treated like "..." in practice)
      if (
        char === "$" &&
        pos + 1 < len &&
        input[pos + 1] === '"' &&
        !inSingleQuote &&
        !inDoubleQuote
      ) {
        // Skip the $ and handle as regular double quote
        pos++;
        col++;
        // Now handle the opening double quote - treat as if word started with quote
        inDoubleQuote = true;
        quoted = true;
        if (value === "") {
          startsWithQuote = true;
        }
        pos++;
        col++;
        continue;
      }

      // Handle quotes
      // For fully quoted words (word is just a quoted string), strip the quotes and set flags.
      // For partially quoted words (not starting with quote), preserve quotes in value for parseWordParts.
      // Track whether there's non-quote content after the closing quote (hasContentAfterQuote).
      if (char === "'" && !inDoubleQuote) {
        if (inSingleQuote) {
          inSingleQuote = false;
          if (!startsWithQuote || hasContentAfterQuote) {
            // Preserve closing quote for partially quoted words
            value += char;
          } else {
            // Check if there's non-quote content after this quote
            const nextChar = pos + 1 < len ? input[pos + 1] : "";
            if (nextChar && !isWordBoundary(nextChar) && nextChar !== "'") {
              // There's content after - check if it's a different quote type
              if (nextChar === '"') {
                // Adjacent different quote types like 'a'"$foo" - need full parsing
                // Preserve the closing single quote for parseWordParts
                hasContentAfterQuote = true;
                value += char;
                singleQuoted = false;
                quoted = false;
              } else {
                // There's non-quote content after - this is a partially quoted word
                // like '_tmp/[bc]'*.mm - need to add the closing quote
                hasContentAfterQuote = true;
                value += char;
              }
            }
            // If next char is same quote type, don't set hasContentAfterQuote - let the parser handle
            // adjacent quotes like 'hello''world'
          }
        } else {
          inSingleQuote = true;
          if (startsWithQuote && !hasContentAfterQuote) {
            // Only set flags if word starts with quote AND no content after quote yet
            singleQuoted = true;
            quoted = true;
          } else {
            // Preserve opening quote for partially quoted words
            value += char;
          }
        }
        pos++;
        col++;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        if (inDoubleQuote) {
          inDoubleQuote = false;
          if (!startsWithQuote || hasContentAfterQuote) {
            // Preserve closing quote for partially quoted words
            value += char;
          } else {
            // Check if there's non-quote content after this quote
            const nextChar = pos + 1 < len ? input[pos + 1] : "";
            if (nextChar && !isWordBoundary(nextChar) && nextChar !== '"') {
              // There's content after - check if it's a different quote type
              if (nextChar === "'") {
                // Adjacent different quote types like "a"'$foo' - need full parsing
                // Preserve the closing double quote for parseWordParts
                hasContentAfterQuote = true;
                value += char;
                singleQuoted = false;
                quoted = false;
              } else {
                // There's non-quote content after - this is a partially quoted word
                hasContentAfterQuote = true;
                value += char;
              }
            }
            // If next char is same quote type, don't set hasContentAfterQuote - let the parser handle
          }
        } else {
          inDoubleQuote = true;
          if (startsWithQuote && !hasContentAfterQuote) {
            // Only set flags if word starts with quote AND no content after quote yet
            quoted = true;
          } else {
            // Preserve opening quote for partially quoted words
            value += char;
          }
        }
        pos++;
        col++;
        continue;
      }

      // Handle escapes
      if (char === "\\" && !inSingleQuote && pos + 1 < len) {
        const nextChar = input[pos + 1];
        if (nextChar === "\n") {
          // Line continuation
          pos += 2;
          ln++;
          col = 1;
          continue;
        }
        if (inDoubleQuote) {
          // In double quotes, only certain escapes are special
          if (
            nextChar === '"' ||
            nextChar === "\\" ||
            nextChar === "$" ||
            nextChar === "`" ||
            nextChar === "\n"
          ) {
            // Keep the backslash for $, `, \, " so parser can handle escapes
            // Only newline is truly consumed (line continuation)
            if (nextChar === "\n") {
              // Line continuation - consume both
              pos += 2;
              col = 1;
              ln++;
              continue;
            }
            // Keep both characters for parser to handle
            value += char + nextChar;
            pos += 2;
            col += 2;
            continue;
          }
        } else {
          // Outside quotes, backslash escapes next character
          // Keep the backslash for:
          // - backslash itself (so parser can distinguish \\ from \)
          // - quotes (so parser knows they're escaped)
          // - glob metacharacters (so parser creates Escaped nodes that won't be glob-expanded)
          // - parentheses (so \( and \) are treated as literal, not extglob operators)
          // - dollar sign (so \$ in regex patterns creates Escaped("$") for literal $ matching)
          // - dash (so \- inside character classes is literal dash, not range)
          // - regex metacharacters (so \. \^ \+ \{ \} work in [[ =~ ]] patterns)
          if (
            nextChar === "\\" ||
            nextChar === '"' ||
            nextChar === "'" ||
            nextChar === "`" ||
            nextChar === "*" ||
            nextChar === "?" ||
            nextChar === "[" ||
            nextChar === "]" ||
            nextChar === "(" ||
            nextChar === ")" ||
            nextChar === "$" ||
            nextChar === "-" ||
            // Regex-specific metacharacters for [[ =~ ]] patterns
            nextChar === "." ||
            nextChar === "^" ||
            nextChar === "+" ||
            nextChar === "{" ||
            nextChar === "}"
          ) {
            value += char + nextChar;
          } else {
            value += nextChar;
          }
          pos += 2;
          col += 2;
          continue;
        }
      }

      // Handle $(...) command substitution - consume the entire construct
      // Skip this handling if inside single quotes ($ is literal in single quotes)
      if (
        char === "$" &&
        pos + 1 < len &&
        input[pos + 1] === "(" &&
        !inSingleQuote
      ) {
        value += char;
        pos++;
        col++;
        // Now consume the $(...)
        value += input[pos]; // Add the (
        pos++;
        col++;
        // Track parenthesis depth with context awareness for case statements
        let depth = 1;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let caseDepth = 0; // Track nested case statements
        let inCasePattern = false; // Are we in case pattern (after 'in', before ')')
        let wordBuffer = ""; // Track recent word for keyword detection
        // Check if this is $((...)) arithmetic expansion
        // When $(( is followed by content that spans multiple lines and closes with ) ),
        // it's $( ( subshell ) ) not $(( arithmetic ))
        const isArithmetic =
          input[pos] === "(" && !this.dollarDparenIsSubshell(pos);
        while (depth > 0 && pos < len) {
          const c = input[pos];
          value += c;

          if (inSingleQuote) {
            if (c === "'") inSingleQuote = false;
          } else if (inDoubleQuote) {
            if (c === "\\" && pos + 1 < len) {
              // Skip escaped char in double quotes
              value += input[pos + 1];
              pos++;
              col++;
            } else if (c === '"') {
              inDoubleQuote = false;
            }
          } else {
            // Not in quotes
            if (c === "'") {
              inSingleQuote = true;
              wordBuffer = "";
            } else if (c === '"') {
              inDoubleQuote = true;
              wordBuffer = "";
            } else if (c === "\\" && pos + 1 < len) {
              // Skip escaped char
              value += input[pos + 1];
              pos++;
              col++;
              wordBuffer = "";
            } else if (c === "$" && pos + 1 < len && input[pos + 1] === "{") {
              // Handle ${...} parameter expansion - consume the entire construct
              // This prevents # inside ${#var} from being treated as a comment
              pos++;
              col++;
              value += input[pos]; // Add the {
              pos++;
              col++;
              let braceDepth = 1;
              let inBraceSingleQuote = false;
              let inBraceDoubleQuote = false;
              while (braceDepth > 0 && pos < len) {
                const bc = input[pos];
                if (bc === "\\" && pos + 1 < len && !inBraceSingleQuote) {
                  // Handle escape sequences
                  value += bc;
                  pos++;
                  col++;
                  value += input[pos];
                  pos++;
                  col++;
                  continue;
                }
                value += bc;
                if (inBraceSingleQuote) {
                  if (bc === "'") inBraceSingleQuote = false;
                } else if (inBraceDoubleQuote) {
                  if (bc === '"') inBraceDoubleQuote = false;
                } else {
                  if (bc === "'") inBraceSingleQuote = true;
                  else if (bc === '"') inBraceDoubleQuote = true;
                  else if (bc === "{") braceDepth++;
                  else if (bc === "}") braceDepth--;
                }
                if (bc === "\n") {
                  ln++;
                  col = 0;
                } else {
                  col++;
                }
                pos++;
              }
              wordBuffer = "";
              continue;
            } else if (
              c === "#" &&
              !isArithmetic && // # is NOT a comment in arithmetic expansion
              (wordBuffer === "" || /\s/.test(input[pos - 1] || ""))
            ) {
              // Comment - skip to end of line (only in command substitution, not arithmetic)
              while (pos + 1 < len && input[pos + 1] !== "\n") {
                pos++;
                col++;
                value += input[pos];
              }
              wordBuffer = "";
            } else if (/[a-zA-Z_]/.test(c)) {
              wordBuffer += c;
            } else {
              // Check for keywords
              if (wordBuffer === "case") {
                caseDepth++;
                inCasePattern = false;
              } else if (wordBuffer === "in" && caseDepth > 0) {
                inCasePattern = true;
              } else if (wordBuffer === "esac" && caseDepth > 0) {
                caseDepth--;
                inCasePattern = false;
              }
              wordBuffer = "";

              if (c === "(") {
                // Check for $( which starts nested command substitution
                if (pos > 0 && input[pos - 1] === "$") {
                  depth++;
                } else if (!inCasePattern) {
                  // Regular ( in non-pattern context
                  depth++;
                }
                // In case pattern, ( is part of extended glob or literal
              } else if (c === ")") {
                if (inCasePattern) {
                  // ) ends the case pattern, doesn't affect depth
                  inCasePattern = false;
                } else {
                  depth--;
                }
              } else if (c === ";") {
                if (caseDepth > 0) {
                  // ;; in case body means next pattern
                  if (pos + 1 < len && input[pos + 1] === ";") {
                    inCasePattern = true;
                  }
                  // ;& or ;;& also end a case clause and start next pattern
                  else if (pos + 1 < len && input[pos + 1] === "&") {
                    inCasePattern = true;
                  }
                }
              }
            }
          }

          if (c === "\n") {
            ln++;
            col = 0;
            wordBuffer = "";
          }
          pos++;
          col++;
        }
        continue;
      }

      // Handle $[...] old-style arithmetic - consume the entire construct
      // Skip this handling if inside single quotes ($ is literal in single quotes)
      if (
        char === "$" &&
        pos + 1 < len &&
        input[pos + 1] === "[" &&
        !inSingleQuote
      ) {
        value += char;
        pos++;
        col++;
        // Now consume the $[...]
        value += input[pos]; // Add the [
        pos++;
        col++;
        // Track bracket depth
        let depth = 1;
        while (depth > 0 && pos < len) {
          const c = input[pos];
          value += c;
          if (c === "[") depth++;
          else if (c === "]") depth--;
          else if (c === "\n") {
            ln++;
            col = 0;
          }
          pos++;
          col++;
        }
        continue;
      }

      // Handle ${...} parameter expansion - consume the entire construct
      // Skip this handling if inside single quotes ($ is literal in single quotes)
      if (
        char === "$" &&
        pos + 1 < len &&
        input[pos + 1] === "{" &&
        !inSingleQuote
      ) {
        value += char;
        pos++;
        col++;
        // Now consume the ${...}
        value += input[pos]; // Add the {
        pos++;
        col++;
        // Track brace depth and quotes inside ${...}
        // Both single and double quotes must be balanced inside parameter expansions
        // e.g., ${var-"}"} - the } inside quotes is literal, not the closing brace
        let depth = 1;
        let inParamSingleQuote = false;
        let inParamDoubleQuote = false;
        let singleQuoteStartLine = ln;
        let singleQuoteStartCol = col;
        let doubleQuoteStartLine = ln;
        let doubleQuoteStartCol = col;
        while (depth > 0 && pos < len) {
          const c = input[pos];
          // Handle backslash-newline line continuation inside ${...}
          if (c === "\\" && pos + 1 < len && input[pos + 1] === "\n") {
            // Skip both the backslash and the newline
            pos += 2;
            ln++;
            col = 1;
            continue;
          }
          // Handle escape sequences inside ${...} - skip escaped characters
          // (but not inside single quotes where backslash is literal)
          if (c === "\\" && pos + 1 < len && !inParamSingleQuote) {
            value += c;
            pos++;
            col++;
            value += input[pos];
            pos++;
            col++;
            continue;
          }
          value += c;
          if (inParamSingleQuote) {
            // Inside single quotes, only ' is special
            if (c === "'") {
              inParamSingleQuote = false;
            }
          } else if (inParamDoubleQuote) {
            // Inside double quotes, only " ends it (escapes handled above)
            if (c === '"') {
              inParamDoubleQuote = false;
            }
          } else {
            // Outside quotes
            if (c === "'") {
              inParamSingleQuote = true;
              singleQuoteStartLine = ln;
              singleQuoteStartCol = col;
            } else if (c === '"') {
              inParamDoubleQuote = true;
              doubleQuoteStartLine = ln;
              doubleQuoteStartCol = col;
            } else if (c === "{") {
              depth++;
            } else if (c === "}") {
              depth--;
            }
          }
          if (c === "\n") {
            ln++;
            col = 0;
          }
          pos++;
          col++;
        }
        // Check for unterminated quotes inside ${...}
        if (inParamSingleQuote) {
          throw new LexerError(
            "unexpected EOF while looking for matching `''",
            singleQuoteStartLine,
            singleQuoteStartCol
          );
        }
        if (inParamDoubleQuote) {
          throw new LexerError(
            "unexpected EOF while looking for matching `\"'",
            doubleQuoteStartLine,
            doubleQuoteStartCol
          );
        }
        continue;
      }

      // Handle special variables $#, $?, $$, $!, $0-$9, $@, $*
      // Skip this handling if inside single quotes ($ is literal in single quotes)
      if (char === "$" && pos + 1 < len && !inSingleQuote) {
        const next = input[pos + 1];
        if (
          next === "#" ||
          next === "?" ||
          next === "$" ||
          next === "!" ||
          next === "@" ||
          next === "*" ||
          next === "-" ||
          (next >= "0" && next <= "9")
        ) {
          value += char + next;
          pos += 2;
          col += 2;
          continue;
        }
      }

      // Handle backtick command substitution - consume the entire construct
      // Skip this handling if inside single quotes (backtick is literal in single quotes)
      if (char === "`" && !inSingleQuote) {
        value += char;
        pos++;
        col++;
        // Find the matching backtick
        while (pos < len && input[pos] !== "`") {
          const c = input[pos];
          value += c;
          if (c === "\\" && pos + 1 < len) {
            value += input[pos + 1];
            pos++;
            col++;
          }
          if (c === "\n") {
            ln++;
            col = 0;
          }
          pos++;
          col++;
        }
        if (pos < len) {
          value += input[pos]; // closing backtick
          pos++;
          col++;
        }
        continue;
      }

      // Regular character
      value += char;
      pos++;
      if (char === "\n") {
        ln++;
        col = 1;
      } else {
        col++;
      }
    }

    // Write back to instance
    this.pos = pos;
    this.column = col;
    this.line = ln;

    // If we detected content after quote, this is a partially quoted word.
    // We already preserved the quotes in the main loop when hasContentAfterQuote became true,
    // but the opening quote was not preserved initially. We need to prepend it.
    if (hasContentAfterQuote && startsWithQuote) {
      const openQuote = input[start];
      value = openQuote + value;
      quoted = false;
      singleQuoted = false;
    }

    // Check for unterminated quotes
    if (inSingleQuote || inDoubleQuote) {
      const quoteType = inSingleQuote ? "'" : '"';
      throw new LexerError(
        `unexpected EOF while looking for matching \`${quoteType}'`,
        line,
        column
      );
    }

    // Check if the word is "fully quoted" - a single quoted string with no unquoted content
    // This is important for proper handling by parseWordParts
    // Fully quoted patterns:
    // - 'content' (single quotes only, starts and ends with single quote)
    // - "content" (double quotes only, starts and ends with double quote)
    // Not fully quoted: 'part1'part2, part1'part2', "part1"'part2'
    // IMPORTANT: Skip this check if the word was already parsed as quoted (startsWithQuote)
    // because the quotes have already been handled correctly during parsing.
    // This prevents mistakenly stripping literal quotes that are part of the content
    // (e.g., '"a,b,c"' should keep the double quotes as content).
    if (!startsWithQuote && value.length >= 2) {
      if (value[0] === "'" && value[value.length - 1] === "'") {
        // Check if there are no other single quotes inside (except at boundaries)
        const inner = value.slice(1, -1);
        if (!inner.includes("'") && !inner.includes('"')) {
          // Fully single-quoted: strip the quotes and set flags
          value = inner;
          quoted = true;
          singleQuoted = true;
        }
      } else if (value[0] === '"' && value[value.length - 1] === '"') {
        // Check if there are no other double quotes inside (except at boundaries)
        // Need to handle escaped quotes inside double quotes
        const inner = value.slice(1, -1);
        // A double-quoted string can contain escaped quotes (\") and single quotes
        // It's fully quoted if there are no unescaped double quotes
        let hasUnescapedQuote = false;
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] === '"') {
            hasUnescapedQuote = true;
            break;
          }
          if (inner[i] === "\\" && i + 1 < inner.length) {
            i++; // Skip escaped char
          }
        }
        if (!hasUnescapedQuote) {
          // Fully double-quoted: strip the quotes and set flags
          value = inner;
          quoted = true;
          singleQuoted = false;
        }
      }
    }

    if (value === "") {
      return {
        type: TokenType.WORD,
        value: "",
        start,
        end: pos,
        line,
        column,
        quoted,
        singleQuoted
      };
    }

    // Check for reserved words (only if not quoted)
    const reservedType2 = RESERVED_WORDS.get(value);
    if (!quoted && reservedType2 !== undefined) {
      return {
        type: reservedType2,
        value,
        start,
        end: pos,
        line,
        column
      };
    }

    // Check for assignment (VAR=value or VAR+=value)
    // Only tokens that don't start with a quote can be assignments.
    // MYVAR="hello" is an assignment (name is unquoted)
    // "MYVAR=hello" is NOT an assignment (starts with quote)
    // Also matches array subscript: a[0]=value, a[idx]=value, a[a[0]]=value, a[x=1]=value
    if (!startsWithQuote) {
      const eqIdx = findAssignmentEq(value);
      if (eqIdx > 0 && isValidAssignmentLHS(value.slice(0, eqIdx))) {
        return {
          type: TokenType.ASSIGNMENT_WORD,
          value,
          start,
          end: pos,
          line,
          column,
          quoted,
          singleQuoted
        };
      }
    }

    // Check for number (for redirections)
    if (/^[0-9]+$/.test(value)) {
      return {
        type: TokenType.NUMBER,
        value,
        start,
        end: pos,
        line,
        column
      };
    }

    // Check for valid name
    if (isValidName(value)) {
      return {
        type: TokenType.NAME,
        value,
        start,
        end: pos,
        line,
        column,
        quoted,
        singleQuoted
      };
    }

    return {
      type: TokenType.WORD,
      value,
      start,
      end: pos,
      line,
      column,
      quoted,
      singleQuoted
    };
  }

  private readHeredocContent(): void {
    // Process each pending here-document
    while (this.pendingHeredocs.length > 0) {
      const heredoc = this.pendingHeredocs.shift();
      if (!heredoc) break;
      const start = this.pos;
      const startLine = this.line;
      const startColumn = this.column;
      let content = "";

      // Read until we find the delimiter on its own line
      while (this.pos < this.input.length) {
        let line = "";

        // Read one line
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
          line += this.input[this.pos];
          this.pos++;
          this.column++;
        }

        // Check for delimiter
        const lineToCheck = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (lineToCheck === heredoc.delimiter) {
          // Consume the newline
          if (this.pos < this.input.length && this.input[this.pos] === "\n") {
            this.pos++;
            this.line++;
            this.column = 1;
          }
          break;
        }

        content += line;
        // Check heredoc size limit to prevent memory exhaustion
        if (content.length > this.maxHeredocSize) {
          throw new LexerError(
            `Heredoc size limit exceeded (${this.maxHeredocSize} bytes)`,
            startLine,
            startColumn
          );
        }
        if (this.pos < this.input.length && this.input[this.pos] === "\n") {
          content += "\n";
          this.pos++;
          this.line++;
          this.column = 1;
        }
      }

      this.tokens.push({
        type: TokenType.HEREDOC_CONTENT,
        value: content,
        start,
        end: this.pos,
        line: startLine,
        column: startColumn
      });
    }
  }

  /**
   * Register a here-document to be read after the next newline
   */
  addPendingHeredoc(
    delimiter: string,
    stripTabs: boolean,
    quoted: boolean
  ): void {
    this.pendingHeredocs.push({ delimiter, stripTabs, quoted });
  }

  /**
   * Look ahead from current position to find the here-doc delimiter
   * and register it as a pending here-doc
   */
  private registerHeredocFromLookahead(stripTabs: boolean): void {
    // Save position (we're just looking ahead, the actual tokens will be parsed later)
    const savedPos = this.pos;
    const savedColumn = this.column;

    // Skip whitespace (but not newlines)
    while (
      this.pos < this.input.length &&
      (this.input[this.pos] === " " || this.input[this.pos] === "\t")
    ) {
      this.pos++;
      this.column++;
    }

    // Read the delimiter - may be composed of multiple quoted/unquoted segments
    // e.g., 'EOF'"2" -> EOF2, EOF -> EOF, "EOF" -> EOF
    let delimiter = "";
    let quoted = false;

    // Keep reading segments until we hit whitespace or operator
    while (this.pos < this.input.length) {
      const char = this.input[this.pos];

      // Stop at whitespace or operators
      if (/[\s;<>&|()]/.test(char)) {
        break;
      }

      if (char === "'" || char === '"') {
        // Quoted segment - any quoting makes the whole delimiter quoted
        quoted = true;
        const quoteChar = char;
        this.pos++;
        this.column++;
        while (
          this.pos < this.input.length &&
          this.input[this.pos] !== quoteChar
        ) {
          delimiter += this.input[this.pos];
          this.pos++;
          this.column++;
        }
        // Skip closing quote
        if (
          this.pos < this.input.length &&
          this.input[this.pos] === quoteChar
        ) {
          this.pos++;
          this.column++;
        }
      } else if (char === "\\") {
        // Backslash escapes the next character (also makes it quoted)
        quoted = true;
        this.pos++;
        this.column++;
        if (this.pos < this.input.length) {
          delimiter += this.input[this.pos];
          this.pos++;
          this.column++;
        }
      } else {
        // Unquoted character
        delimiter += char;
        this.pos++;
        this.column++;
      }
    }

    // Restore position so actual tokenization continues normally
    this.pos = savedPos;
    this.column = savedColumn;

    // Register the here-doc if we found a delimiter
    if (delimiter) {
      this.pendingHeredocs.push({ delimiter, stripTabs, quoted });
    }
  }

  /**
   * Check if position is followed by word characters (not a word boundary).
   * Used to determine if } should be literal or RBRACE token.
   */
  private isWordCharFollowing(pos: number): boolean {
    if (pos >= this.input.length) return false;
    const c = this.input[pos];
    // Word continues if followed by non-boundary characters
    return !(
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === ";" ||
      c === "&" ||
      c === "|" ||
      c === "(" ||
      c === ")" ||
      c === "<" ||
      c === ">"
    );
  }

  /**
   * Read a word that starts with a brace expansion.
   * Includes the brace expansion plus any suffix characters and additional brace expansions.
   */
  private readWordWithBraceExpansion(
    start: number,
    line: number,
    column: number
  ): Token {
    const input = this.input;
    const len = input.length;
    let pos = start;
    let col = column;

    // Read the word which may contain multiple brace expansions
    while (pos < len) {
      const c = input[pos];

      // Stop at word boundaries
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "&" ||
        c === "|" ||
        c === "(" ||
        c === ")" ||
        c === "<" ||
        c === ">"
      ) {
        break;
      }

      // Handle opening brace
      if (c === "{") {
        // Check if this is a valid brace expansion
        const braceExp = this.scanBraceExpansion(pos);
        if (braceExp !== null) {
          // Valid brace expansion - consume it entirely
          let depth = 1;
          pos++;
          col++;
          while (pos < len && depth > 0) {
            if (input[pos] === "{") depth++;
            else if (input[pos] === "}") depth--;
            pos++;
            col++;
          }
          continue;
        }
        // Not a valid brace expansion - treat { as a literal character
        pos++;
        col++;
        continue;
      }

      // Handle closing brace - treat as literal (part of suffix like "a}")
      if (c === "}") {
        pos++;
        col++;
        continue;
      }

      // Handle $(...) or $((...)) - consume the entire construct
      if (c === "$" && pos + 1 < len && input[pos + 1] === "(") {
        pos++; // Skip $
        col++;
        pos++; // Skip first (
        col++;
        let depth = 1;
        while (depth > 0 && pos < len) {
          if (input[pos] === "(") depth++;
          else if (input[pos] === ")") depth--;
          pos++;
          col++;
        }
        continue;
      }

      // Handle ${...} parameter expansion
      if (c === "$" && pos + 1 < len && input[pos + 1] === "{") {
        pos++; // Skip $
        col++;
        pos++; // Skip {
        col++;
        let depth = 1;
        while (depth > 0 && pos < len) {
          if (input[pos] === "{") depth++;
          else if (input[pos] === "}") depth--;
          pos++;
          col++;
        }
        continue;
      }

      // Handle backtick command substitution
      if (c === "`") {
        pos++; // Skip opening `
        col++;
        while (pos < len && input[pos] !== "`") {
          if (input[pos] === "\\" && pos + 1 < len) {
            pos += 2; // Skip escape sequence
            col += 2;
          } else {
            pos++;
            col++;
          }
        }
        if (pos < len) {
          pos++; // Skip closing `
          col++;
        }
        continue;
      }

      // Regular character
      pos++;
      col++;
    }

    const value = input.slice(start, pos);
    this.pos = pos;
    this.column = col;

    return {
      type: TokenType.WORD,
      value,
      start,
      end: pos,
      line,
      column,
      quoted: false,
      singleQuoted: false
    };
  }

  /**
   * Scan ahead to detect brace expansion pattern.
   * Returns the full brace expansion string if found, null otherwise.
   * Brace expansion must contain either:
   * - A comma (e.g., {a,b,c})
   * - A range with .. (e.g., {1..10})
   */
  private scanBraceExpansion(startPos: number): string | null {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1; // Skip the opening {
    let depth = 1;
    let hasComma = false;
    let hasRange = false;

    while (pos < len && depth > 0) {
      const c = input[pos];

      if (c === "{") {
        depth++;
        pos++;
      } else if (c === "}") {
        depth--;
        pos++;
      } else if (c === "," && depth === 1) {
        hasComma = true;
        pos++;
      } else if (c === "." && pos + 1 < len && input[pos + 1] === ".") {
        hasRange = true;
        pos += 2;
      } else if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "&" ||
        c === "|"
      ) {
        // Hit a word boundary before closing brace - not a valid brace expansion
        return null;
      } else {
        pos++;
      }
    }

    // Must have closing brace and either comma or range
    if (depth === 0 && (hasComma || hasRange)) {
      return input.slice(startPos, pos);
    }

    return null;
  }

  /**
   * Scan a literal brace word like {foo} (no comma, no range).
   * Returns the literal string if found, null otherwise.
   * This is used when {} contains something but it's not a valid brace expansion.
   */
  private scanLiteralBraceWord(startPos: number): string | null {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1; // Skip the opening {
    let depth = 1;

    while (pos < len && depth > 0) {
      const c = input[pos];

      if (c === "{") {
        depth++;
        pos++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          // Found the closing brace - return the entire {content}
          return input.slice(startPos, pos + 1);
        }
        pos++;
      } else if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "&" ||
        c === "|"
      ) {
        // Hit a word boundary before closing brace
        return null;
      } else {
        pos++;
      }
    }

    return null;
  }

  /**
   * Scan an extglob pattern starting at the opening parenthesis.
   * Extglob patterns are: @(...), *(...), +(...), ?(...), !(...)
   * The operator (@, *, +, ?, !) is already consumed; we start at the (.
   * Returns the content including parentheses, or null if not a valid extglob.
   */
  private scanExtglobPattern(
    startPos: number
  ): { content: string; end: number } | null {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1; // Skip the opening (
    let depth = 1;

    while (pos < len && depth > 0) {
      const c = input[pos];

      // Handle escapes
      if (c === "\\" && pos + 1 < len) {
        pos += 2;
        continue;
      }

      // Handle nested extglob patterns
      if ("@*+?!".includes(c) && pos + 1 < len && input[pos + 1] === "(") {
        pos++; // Skip the extglob operator
        depth++;
        pos++; // Skip the (
        continue;
      }

      if (c === "(") {
        depth++;
        pos++;
      } else if (c === ")") {
        depth--;
        pos++;
      } else if (c === "\n") {
        // Newline inside extglob is not allowed (bash behavior)
        return null;
      } else {
        pos++;
      }
    }

    // Must have balanced parentheses
    if (depth === 0) {
      return {
        content: input.slice(startPos, pos),
        end: pos
      };
    }

    return null;
  }

  /**
   * Scan for FD variable syntax: {varname} immediately followed by a redirect operator.
   * This is the bash 4.1+ feature where {fd}>file allocates an FD and stores it in variable.
   * Returns the variable name and end position if found, null otherwise.
   *
   * Valid patterns:
   * - {varname}>file, {varname}>>file, {varname}>|file
   * - {varname}<file, {varname}<<word, {varname}<<<word
   * - {varname}<>file
   * - {varname}>&N, {varname}<&N
   * - {varname}>&-, {varname}<&- (close FD)
   */
  private scanFdVariable(
    startPos: number
  ): { varname: string; end: number } | null {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1; // Skip the opening {

    // Scan variable name (must be valid identifier)
    const nameStart = pos;
    while (pos < len) {
      const c = input[pos];
      if (pos === nameStart) {
        // First char must be letter or underscore
        if (!((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_")) {
          return null;
        }
      } else {
        // Subsequent chars can include digits
        if (
          !(
            (c >= "a" && c <= "z") ||
            (c >= "A" && c <= "Z") ||
            (c >= "0" && c <= "9") ||
            c === "_"
          )
        ) {
          break;
        }
      }
      pos++;
    }

    // Must have at least one character in the variable name
    if (pos === nameStart) {
      return null;
    }

    const varname = input.slice(nameStart, pos);

    // Must be followed by closing brace
    if (pos >= len || input[pos] !== "}") {
      return null;
    }
    pos++; // Skip the closing }

    // Must be immediately followed by a redirect operator (no whitespace)
    if (pos >= len) {
      return null;
    }

    const c = input[pos];
    const c2 = pos + 1 < len ? input[pos + 1] : "";

    // Check for valid redirect operators
    const isRedirectOp =
      c === ">" || // >, >>, >&, >|
      c === "<" || // <, <<, <&, <<<, <>
      (c === "&" && (c2 === ">" || c2 === "<")); // &>, &>>

    if (!isRedirectOp) {
      return null;
    }

    return { varname, end: pos };
  }

  /**
   * Scan ahead from a $(( position to determine if it should be treated as
   * $( ( subshell ) ) instead of $(( arithmetic )).
   * This handles cases like:
   *   echo $(( echo 1
   *   echo 2
   *   ) )
   * which should be a command substitution containing a subshell, not arithmetic.
   *
   * @param startPos - position at the second ( (i.e., at input[startPos] === "(")
   * @returns true if this is a subshell (closes with ) )), false if arithmetic (closes with )))
   */
  private dollarDparenIsSubshell(startPos: number): boolean {
    const input = this.input;
    const len = input.length;
    let pos = startPos + 1; // Skip the second (
    let depth = 2; // We've seen $((, so we start at depth 2
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let hasNewline = false;

    while (pos < len && depth > 0) {
      const c = input[pos];

      if (inSingleQuote) {
        if (c === "'") {
          inSingleQuote = false;
        }
        if (c === "\n") hasNewline = true;
        pos++;
        continue;
      }

      if (inDoubleQuote) {
        if (c === "\\") {
          // Skip escaped char
          pos += 2;
          continue;
        }
        if (c === '"') {
          inDoubleQuote = false;
        }
        if (c === "\n") hasNewline = true;
        pos++;
        continue;
      }

      // Not in quotes
      if (c === "'") {
        inSingleQuote = true;
        pos++;
        continue;
      }

      if (c === '"') {
        inDoubleQuote = true;
        pos++;
        continue;
      }

      if (c === "\\") {
        // Skip escaped char
        pos += 2;
        continue;
      }

      if (c === "\n") {
        hasNewline = true;
      }

      if (c === "(") {
        depth++;
        pos++;
        continue;
      }

      if (c === ")") {
        depth--;
        if (depth === 1) {
          // We've closed the inner subshell. Check what follows.
          // For ) ) with whitespace, this is a subshell
          // For )), this is arithmetic
          const nextPos = pos + 1;
          if (nextPos < len && input[nextPos] === ")") {
            // )) - adjacent parens = arithmetic (or at least could be)
            // But if we have newlines AND it closes with ) ), it's a subshell
            // Actually, let's check if there's whitespace then )
            return false;
          }
          // Check if there's whitespace followed by )
          let scanPos = nextPos;
          let hasWhitespace = false;
          while (
            scanPos < len &&
            (input[scanPos] === " " ||
              input[scanPos] === "\t" ||
              input[scanPos] === "\n")
          ) {
            hasWhitespace = true;
            scanPos++;
          }
          if (hasWhitespace && scanPos < len && input[scanPos] === ")") {
            // This is ) ) with whitespace - subshell
            return true;
          }
          // The ) is followed by something else - could still be valid subshell
          // If it has newlines, treat as subshell (commands span multiple lines)
          if (hasNewline) {
            return true;
          }
        }
        if (depth === 0) {
          // We closed all parens without finding a ) ) pattern
          return false;
        }
        pos++;
        continue;
      }

      pos++;
    }

    // Didn't find a definitive answer - default to arithmetic behavior
    return false;
  }

  /**
   * Scan ahead from a (( position to determine if it closes with ) ) (nested subshells)
   * or )) (arithmetic). We need to track paren depth and quotes to find the matching close.
   * @param startPos - position after the (( (i.e., at the first char of content)
   * @returns true if it closes with ) ) (space between parens), false otherwise
   */
  private dparenClosesWithSpacedParens(startPos: number): boolean {
    const input = this.input;
    const len = input.length;
    let pos = startPos;
    let depth = 2; // We've seen ((, so we start at depth 2
    let inSingleQuote = false;
    let inDoubleQuote = false;

    while (pos < len && depth > 0) {
      const c = input[pos];

      if (inSingleQuote) {
        if (c === "'") {
          inSingleQuote = false;
        }
        pos++;
        continue;
      }

      if (inDoubleQuote) {
        if (c === "\\") {
          // Skip escaped char
          pos += 2;
          continue;
        }
        if (c === '"') {
          inDoubleQuote = false;
        }
        pos++;
        continue;
      }

      // Not in quotes
      if (c === "'") {
        inSingleQuote = true;
        pos++;
        continue;
      }

      if (c === '"') {
        inDoubleQuote = true;
        pos++;
        continue;
      }

      if (c === "\\") {
        // Skip escaped char
        pos += 2;
        continue;
      }

      if (c === "(") {
        depth++;
        pos++;
        continue;
      }

      if (c === ")") {
        depth--;
        if (depth === 1) {
          // Check if next char is another ) with whitespace between them
          // For ) ), there MUST be whitespace between them to be nested subshells
          // If they are adjacent ))  it's arithmetic
          const nextPos = pos + 1;
          if (nextPos < len && input[nextPos] === ")") {
            // )) - adjacent parens = arithmetic, not nested subshells
            return false;
          }
          // Check if there's whitespace followed by )
          let scanPos = nextPos;
          let hasWhitespace = false;
          while (
            scanPos < len &&
            (input[scanPos] === " " ||
              input[scanPos] === "\t" ||
              input[scanPos] === "\n")
          ) {
            hasWhitespace = true;
            scanPos++;
          }
          if (hasWhitespace && scanPos < len && input[scanPos] === ")") {
            // This is ) ) with whitespace - nested subshells
            return true;
          }
          // The ) is followed by something else
          // Continue scanning - this could still be valid
        }
        if (depth === 0) {
          // We closed all parens without finding a ) ) pattern
          return false;
        }
        pos++;
        continue;
      }

      // Check for || or && or | at depth 1 (between inner subshells)
      // At depth 1, we're inside the outer (( but outside any inner parens.
      // If we see || or && or | here, it's connecting commands, not arithmetic.
      // Example: ((cmd1) || (cmd2)) - after (cmd1), depth is 1, then || appears
      // Example: ((cmd1) | cmd2) - pipeline between subshell and command
      // Note: At depth 2, || and && and | could be arithmetic operators, so we don't check there.
      if (depth === 1) {
        if (c === "|" && pos + 1 < len && input[pos + 1] === "|") {
          return true;
        }
        if (c === "&" && pos + 1 < len && input[pos + 1] === "&") {
          return true;
        }
        if (c === "|" && pos + 1 < len && input[pos + 1] !== "|") {
          // Single | - pipeline operator
          return true;
        }
        // Don't check for ; at depth 1 - it could be after a command in nested subshell
      }

      pos++;
    }

    // Didn't find a definitive answer - default to arithmetic behavior
    return false;
  }
}
