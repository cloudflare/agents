/**
 * AWK Lexer
 *
 * Tokenizes AWK source code into a stream of tokens.
 */

export enum TokenType {
  // Literals
  NUMBER = "NUMBER",
  STRING = "STRING",
  REGEX = "REGEX",

  // Identifiers
  IDENT = "IDENT",

  // Keywords
  BEGIN = "BEGIN",
  END = "END",
  IF = "IF",
  ELSE = "ELSE",
  WHILE = "WHILE",
  DO = "DO",
  FOR = "FOR",
  IN = "IN",
  BREAK = "BREAK",
  CONTINUE = "CONTINUE",
  NEXT = "NEXT",
  NEXTFILE = "NEXTFILE",
  EXIT = "EXIT",
  RETURN = "RETURN",
  DELETE = "DELETE",
  FUNCTION = "FUNCTION",
  PRINT = "PRINT",
  PRINTF = "PRINTF",
  GETLINE = "GETLINE",

  // Operators
  PLUS = "PLUS",
  MINUS = "MINUS",
  STAR = "STAR",
  SLASH = "SLASH",
  PERCENT = "PERCENT",
  CARET = "CARET",

  EQ = "EQ",
  NE = "NE",
  LT = "LT",
  GT = "GT",
  LE = "LE",
  GE = "GE",

  MATCH = "MATCH",
  NOT_MATCH = "NOT_MATCH",

  AND = "AND",
  OR = "OR",
  NOT = "NOT",

  ASSIGN = "ASSIGN",
  PLUS_ASSIGN = "PLUS_ASSIGN",
  MINUS_ASSIGN = "MINUS_ASSIGN",
  STAR_ASSIGN = "STAR_ASSIGN",
  SLASH_ASSIGN = "SLASH_ASSIGN",
  PERCENT_ASSIGN = "PERCENT_ASSIGN",
  CARET_ASSIGN = "CARET_ASSIGN",

  INCREMENT = "INCREMENT",
  DECREMENT = "DECREMENT",

  QUESTION = "QUESTION",
  COLON = "COLON",

  COMMA = "COMMA",
  SEMICOLON = "SEMICOLON",
  NEWLINE = "NEWLINE",

  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  LBRACE = "LBRACE",
  RBRACE = "RBRACE",
  LBRACKET = "LBRACKET",
  RBRACKET = "RBRACKET",

  DOLLAR = "DOLLAR",
  APPEND = "APPEND",
  PIPE = "PIPE",

  EOF = "EOF"
}

const KEYWORDS = new Map<string, TokenType>([
  ["BEGIN", TokenType.BEGIN],
  ["END", TokenType.END],
  ["if", TokenType.IF],
  ["else", TokenType.ELSE],
  ["while", TokenType.WHILE],
  ["do", TokenType.DO],
  ["for", TokenType.FOR],
  ["in", TokenType.IN],
  ["break", TokenType.BREAK],
  ["continue", TokenType.CONTINUE],
  ["next", TokenType.NEXT],
  ["nextfile", TokenType.NEXTFILE],
  ["exit", TokenType.EXIT],
  ["return", TokenType.RETURN],
  ["delete", TokenType.DELETE],
  ["function", TokenType.FUNCTION],
  ["print", TokenType.PRINT],
  ["printf", TokenType.PRINTF],
  ["getline", TokenType.GETLINE]
]);

export interface Token {
  type: TokenType;
  value: string | number;
  line: number;
  column: number;
}

/**
 * Expand POSIX character classes in regex patterns
 */
function expandPosixClasses(pattern: string): string {
  return pattern
    .replace(/\[\[:space:\]\]/g, "[ \\t\\n\\r\\f\\v]")
    .replace(/\[\[:blank:\]\]/g, "[ \\t]")
    .replace(/\[\[:alpha:\]\]/g, "[a-zA-Z]")
    .replace(/\[\[:digit:\]\]/g, "[0-9]")
    .replace(/\[\[:alnum:\]\]/g, "[a-zA-Z0-9]")
    .replace(/\[\[:upper:\]\]/g, "[A-Z]")
    .replace(/\[\[:lower:\]\]/g, "[a-z]")
    .replace(/\[\[:punct:\]\]/g, "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~]")
    .replace(/\[\[:xdigit:\]\]/g, "[0-9A-Fa-f]")
    .replace(/\[\[:graph:\]\]/g, "[!-~]")
    .replace(/\[\[:print:\]\]/g, "[ -~]")
    .replace(/\[\[:cntrl:\]\]/g, "[\\x00-\\x1f\\x7f]");
}

export class AwkLexer {
  private input: string;
  private pos = 0;
  private line = 1;
  private column = 1;
  private lastTokenType: TokenType | null = null;

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.input.length) {
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
        this.lastTokenType = token.type;
      }
    }
    tokens.push(this.makeToken(TokenType.EOF, ""));
    return tokens;
  }

  private makeToken(type: TokenType, value: string | number): Token {
    return { type, value, line: this.line, column: this.column };
  }

  private peek(offset = 0): string {
    return this.input[this.pos + offset] || "";
  }

  private advance(): string {
    const ch = this.input[this.pos++] || "";
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.advance();
      } else if (ch === "\\") {
        // Line continuation
        if (this.peek(1) === "\n") {
          this.advance(); // skip \
          this.advance(); // skip \n
        } else {
          break;
        }
      } else if (ch === "#") {
        // Comment - skip to end of line
        while (this.pos < this.input.length && this.peek() !== "\n") {
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private nextToken(): Token | null {
    this.skipWhitespace();

    if (this.pos >= this.input.length) {
      return null;
    }

    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.peek();

    // Newline
    if (ch === "\n") {
      this.advance();
      return {
        type: TokenType.NEWLINE,
        value: "\n",
        line: startLine,
        column: startColumn
      };
    }

    // String literal
    if (ch === '"') {
      return this.readString();
    }

    // Regex literal - context-sensitive
    if (ch === "/" && this.canBeRegex()) {
      return this.readRegex();
    }

    // Number
    if (this.isDigit(ch) || (ch === "." && this.isDigit(this.peek(1)))) {
      return this.readNumber();
    }

    // Identifier or keyword
    if (this.isAlpha(ch) || ch === "_") {
      return this.readIdentifier();
    }

    // Operators and punctuation
    return this.readOperator();
  }

  private canBeRegex(): boolean {
    // Regex can appear after these tokens (or at start)
    const regexPreceders = new Set([
      null,
      TokenType.NEWLINE,
      TokenType.SEMICOLON,
      TokenType.LBRACE,
      TokenType.RBRACE, // After closing action block, a new rule may start with regex
      TokenType.LPAREN,
      TokenType.LBRACKET,
      TokenType.COMMA,
      TokenType.ASSIGN,
      TokenType.PLUS_ASSIGN,
      TokenType.MINUS_ASSIGN,
      TokenType.STAR_ASSIGN,
      TokenType.SLASH_ASSIGN,
      TokenType.PERCENT_ASSIGN,
      TokenType.CARET_ASSIGN,
      TokenType.AND,
      TokenType.OR,
      TokenType.NOT,
      TokenType.MATCH,
      TokenType.NOT_MATCH,
      TokenType.QUESTION,
      TokenType.COLON,
      TokenType.LT,
      TokenType.GT,
      TokenType.LE,
      TokenType.GE,
      TokenType.EQ,
      TokenType.NE,
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.STAR,
      TokenType.PERCENT,
      TokenType.CARET,
      TokenType.PRINT,
      TokenType.PRINTF,
      TokenType.IF,
      TokenType.WHILE,
      TokenType.DO,
      TokenType.FOR,
      TokenType.RETURN
    ]);
    return regexPreceders.has(this.lastTokenType);
  }

  private readString(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // skip opening quote
    let value = "";

    while (this.pos < this.input.length && this.peek() !== '"') {
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          case "f":
            value += "\f";
            break;
          case "b":
            value += "\b";
            break;
          case "v":
            value += "\v";
            break;
          case "a":
            value += "\x07"; // bell/alert
            break;
          case "\\":
            value += "\\";
            break;
          case '"':
            value += '"';
            break;
          case "/":
            value += "/";
            break;
          case "x": {
            // Hex escape: \xHH (2 hex digits max)
            // Note: Different AWK implementations vary in how many digits they consume
            // We use 2 digits which matches OneTrue AWK test expectations
            let hex = "";
            while (hex.length < 2 && /[0-9a-fA-F]/.test(this.peek())) {
              hex += this.advance();
            }
            if (hex.length > 0) {
              value += String.fromCharCode(parseInt(hex, 16));
            } else {
              value += "x"; // No hex digits, treat as literal x
            }
            break;
          }
          default:
            // Check for octal escape: \0 to \377
            if (/[0-7]/.test(escaped)) {
              let octal = escaped;
              // Read up to 2 more octal digits (max 3 total)
              while (octal.length < 3 && /[0-7]/.test(this.peek())) {
                octal += this.advance();
              }
              value += String.fromCharCode(parseInt(octal, 8));
            } else {
              value += escaped;
            }
        }
      } else {
        value += this.advance();
      }
    }

    if (this.peek() === '"') {
      this.advance(); // skip closing quote
    }

    return {
      type: TokenType.STRING,
      value,
      line: startLine,
      column: startColumn
    };
  }

  private readRegex(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // skip opening /
    let pattern = "";

    while (this.pos < this.input.length && this.peek() !== "/") {
      if (this.peek() === "\\") {
        pattern += this.advance();
        if (this.pos < this.input.length) {
          pattern += this.advance();
        }
      } else if (this.peek() === "\n") {
        // Unterminated regex
        break;
      } else {
        pattern += this.advance();
      }
    }

    if (this.peek() === "/") {
      this.advance(); // skip closing /
    }

    // Expand POSIX character classes
    pattern = expandPosixClasses(pattern);

    return {
      type: TokenType.REGEX,
      value: pattern,
      line: startLine,
      column: startColumn
    };
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    let numStr = "";

    // Integer part
    while (this.isDigit(this.peek())) {
      numStr += this.advance();
    }

    // Decimal part
    if (this.peek() === "." && this.isDigit(this.peek(1))) {
      numStr += this.advance(); // .
      while (this.isDigit(this.peek())) {
        numStr += this.advance();
      }
    }

    // Exponent part
    if (this.peek() === "e" || this.peek() === "E") {
      numStr += this.advance();
      if (this.peek() === "+" || this.peek() === "-") {
        numStr += this.advance();
      }
      while (this.isDigit(this.peek())) {
        numStr += this.advance();
      }
    }

    return {
      type: TokenType.NUMBER,
      value: parseFloat(numStr),
      line: startLine,
      column: startColumn
    };
  }

  private readIdentifier(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    let name = "";

    while (this.isAlphaNumeric(this.peek()) || this.peek() === "_") {
      name += this.advance();
    }

    const keywordType = KEYWORDS.get(name);
    if (keywordType !== undefined) {
      return {
        type: keywordType,
        value: name,
        line: startLine,
        column: startColumn
      };
    }

    return {
      type: TokenType.IDENT,
      value: name,
      line: startLine,
      column: startColumn
    };
  }

  private readOperator(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.advance();
    const next = this.peek();

    switch (ch) {
      case "+":
        if (next === "+") {
          this.advance();
          return {
            type: TokenType.INCREMENT,
            value: "++",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.PLUS_ASSIGN,
            value: "+=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.PLUS,
          value: "+",
          line: startLine,
          column: startColumn
        };

      case "-":
        if (next === "-") {
          this.advance();
          return {
            type: TokenType.DECREMENT,
            value: "--",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.MINUS_ASSIGN,
            value: "-=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.MINUS,
          value: "-",
          line: startLine,
          column: startColumn
        };

      case "*":
        if (next === "*") {
          this.advance();
          // ** is an alias for ^ (power operator)
          return {
            type: TokenType.CARET,
            value: "**",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.STAR_ASSIGN,
            value: "*=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.STAR,
          value: "*",
          line: startLine,
          column: startColumn
        };

      case "/":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.SLASH_ASSIGN,
            value: "/=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.SLASH,
          value: "/",
          line: startLine,
          column: startColumn
        };

      case "%":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.PERCENT_ASSIGN,
            value: "%=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.PERCENT,
          value: "%",
          line: startLine,
          column: startColumn
        };

      case "^":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.CARET_ASSIGN,
            value: "^=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.CARET,
          value: "^",
          line: startLine,
          column: startColumn
        };

      case "=":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.EQ,
            value: "==",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.ASSIGN,
          value: "=",
          line: startLine,
          column: startColumn
        };

      case "!":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.NE,
            value: "!=",
            line: startLine,
            column: startColumn
          };
        }
        if (next === "~") {
          this.advance();
          return {
            type: TokenType.NOT_MATCH,
            value: "!~",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.NOT,
          value: "!",
          line: startLine,
          column: startColumn
        };

      case "<":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.LE,
            value: "<=",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.LT,
          value: "<",
          line: startLine,
          column: startColumn
        };

      case ">":
        if (next === "=") {
          this.advance();
          return {
            type: TokenType.GE,
            value: ">=",
            line: startLine,
            column: startColumn
          };
        }
        if (next === ">") {
          this.advance();
          return {
            type: TokenType.APPEND,
            value: ">>",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.GT,
          value: ">",
          line: startLine,
          column: startColumn
        };

      case "&":
        if (next === "&") {
          this.advance();
          return {
            type: TokenType.AND,
            value: "&&",
            line: startLine,
            column: startColumn
          };
        }
        // Single & is not valid in AWK, treat as unknown
        return {
          type: TokenType.IDENT,
          value: "&",
          line: startLine,
          column: startColumn
        };

      case "|":
        if (next === "|") {
          this.advance();
          return {
            type: TokenType.OR,
            value: "||",
            line: startLine,
            column: startColumn
          };
        }
        return {
          type: TokenType.PIPE,
          value: "|",
          line: startLine,
          column: startColumn
        };

      case "~":
        return {
          type: TokenType.MATCH,
          value: "~",
          line: startLine,
          column: startColumn
        };

      case "?":
        return {
          type: TokenType.QUESTION,
          value: "?",
          line: startLine,
          column: startColumn
        };

      case ":":
        return {
          type: TokenType.COLON,
          value: ":",
          line: startLine,
          column: startColumn
        };

      case ",":
        return {
          type: TokenType.COMMA,
          value: ",",
          line: startLine,
          column: startColumn
        };

      case ";":
        return {
          type: TokenType.SEMICOLON,
          value: ";",
          line: startLine,
          column: startColumn
        };

      case "(":
        return {
          type: TokenType.LPAREN,
          value: "(",
          line: startLine,
          column: startColumn
        };

      case ")":
        return {
          type: TokenType.RPAREN,
          value: ")",
          line: startLine,
          column: startColumn
        };

      case "{":
        return {
          type: TokenType.LBRACE,
          value: "{",
          line: startLine,
          column: startColumn
        };

      case "}":
        return {
          type: TokenType.RBRACE,
          value: "}",
          line: startLine,
          column: startColumn
        };

      case "[":
        return {
          type: TokenType.LBRACKET,
          value: "[",
          line: startLine,
          column: startColumn
        };

      case "]":
        return {
          type: TokenType.RBRACKET,
          value: "]",
          line: startLine,
          column: startColumn
        };

      case "$":
        return {
          type: TokenType.DOLLAR,
          value: "$",
          line: startLine,
          column: startColumn
        };

      default:
        // Unknown character - return as identifier to allow graceful handling
        return {
          type: TokenType.IDENT,
          value: ch,
          line: startLine,
          column: startColumn
        };
    }
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isAlpha(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
  }

  private isAlphaNumeric(ch: string): boolean {
    return this.isDigit(ch) || this.isAlpha(ch);
  }
}
