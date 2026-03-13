/**
 * SED Lexer
 *
 * Tokenizes sed scripts into a stream of tokens.
 * Sed has context-sensitive tokenization - the meaning of characters
 * depends heavily on what command is being parsed.
 */

export enum SedTokenType {
  // Addresses
  NUMBER = "NUMBER",
  DOLLAR = "DOLLAR", // $ - last line
  PATTERN = "PATTERN", // /regex/
  STEP = "STEP", // first~step
  RELATIVE_OFFSET = "RELATIVE_OFFSET", // +N (GNU extension: ,+N range)

  // Structure
  LBRACE = "LBRACE", // {
  RBRACE = "RBRACE", // }
  SEMICOLON = "SEMICOLON", // ;
  NEWLINE = "NEWLINE",
  COMMA = "COMMA", // , - address range separator
  NEGATION = "NEGATION", // ! - negate address

  // Commands (single character)
  COMMAND = "COMMAND", // p, d, h, H, g, G, x, n, N, P, D, q, Q, z, =, l, F, v

  // Complex commands (parsed specially)
  SUBSTITUTE = "SUBSTITUTE", // s/pattern/replacement/flags
  TRANSLITERATE = "TRANSLITERATE", // y/source/dest/
  LABEL_DEF = "LABEL_DEF", // :name
  BRANCH = "BRANCH", // b [label]
  BRANCH_ON_SUBST = "BRANCH_ON_SUBST", // t [label]
  BRANCH_ON_NO_SUBST = "BRANCH_ON_NO_SUBST", // T [label]
  TEXT_CMD = "TEXT_CMD", // a\, i\, c\ with text
  FILE_READ = "FILE_READ", // r filename
  FILE_READ_LINE = "FILE_READ_LINE", // R filename
  FILE_WRITE = "FILE_WRITE", // w filename
  FILE_WRITE_LINE = "FILE_WRITE_LINE", // W filename
  EXECUTE = "EXECUTE", // e [command]
  VERSION = "VERSION", // v [version]

  EOF = "EOF",
  ERROR = "ERROR"
}

export interface SedToken {
  type: SedTokenType;
  value: string | number;
  // For complex tokens, additional parsed data
  pattern?: string;
  replacement?: string;
  flags?: string;
  source?: string;
  dest?: string;
  text?: string;
  label?: string;
  filename?: string;
  command?: string; // for execute command
  first?: number; // for step address
  step?: number; // for step address
  offset?: number; // for relative offset address (+N)
  line: number;
  column: number;
}

export class SedLexer {
  private input: string;
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): SedToken[] {
    const tokens: SedToken[] = [];
    while (this.pos < this.input.length) {
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }
    tokens.push(this.makeToken(SedTokenType.EOF, ""));
    return tokens;
  }

  private makeToken(
    type: SedTokenType,
    value: string | number,
    extra?: Partial<SedToken>
  ): SedToken {
    return { type, value, line: this.line, column: this.column, ...extra };
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

  /**
   * Read an escaped string until the delimiter is reached.
   * Handles escape sequences: \n -> newline, \t -> tab, \X -> X
   * Returns null if newline is encountered before delimiter.
   */
  private readEscapedString(delimiter: string): string | null {
    let result = "";
    while (this.pos < this.input.length && this.peek() !== delimiter) {
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        if (escaped === "n") result += "\n";
        else if (escaped === "t") result += "\t";
        else result += escaped;
      } else if (this.peek() === "\n") {
        return null; // Unterminated - newline before delimiter
      } else {
        result += this.advance();
      }
    }
    return result;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.advance();
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

  private nextToken(): SedToken | null {
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
        type: SedTokenType.NEWLINE,
        value: "\n",
        line: startLine,
        column: startColumn
      };
    }

    // Semicolon
    if (ch === ";") {
      this.advance();
      return {
        type: SedTokenType.SEMICOLON,
        value: ";",
        line: startLine,
        column: startColumn
      };
    }

    // Braces
    if (ch === "{") {
      this.advance();
      return {
        type: SedTokenType.LBRACE,
        value: "{",
        line: startLine,
        column: startColumn
      };
    }
    if (ch === "}") {
      this.advance();
      return {
        type: SedTokenType.RBRACE,
        value: "}",
        line: startLine,
        column: startColumn
      };
    }

    // Comma (address range separator)
    if (ch === ",") {
      this.advance();
      return {
        type: SedTokenType.COMMA,
        value: ",",
        line: startLine,
        column: startColumn
      };
    }

    // Negation modifier (!)
    if (ch === "!") {
      this.advance();
      return {
        type: SedTokenType.NEGATION,
        value: "!",
        line: startLine,
        column: startColumn
      };
    }

    // Dollar (last line address)
    if (ch === "$") {
      this.advance();
      return {
        type: SedTokenType.DOLLAR,
        value: "$",
        line: startLine,
        column: startColumn
      };
    }

    // Number or step address (first~step)
    if (this.isDigit(ch)) {
      return this.readNumber();
    }

    // Relative offset address +N (GNU extension for ,+N ranges)
    if (ch === "+" && this.isDigit(this.input[this.pos + 1] || "")) {
      return this.readRelativeOffset();
    }

    // Pattern address /regex/
    if (ch === "/") {
      return this.readPattern();
    }

    // Label definition :name
    if (ch === ":") {
      return this.readLabelDef();
    }

    // Commands
    return this.readCommand();
  }

  private readNumber(): SedToken {
    const startLine = this.line;
    const startColumn = this.column;
    let numStr = "";

    while (this.isDigit(this.peek())) {
      numStr += this.advance();
    }

    // Check for step address: first~step
    if (this.peek() === "~") {
      this.advance(); // skip ~
      let stepStr = "";
      while (this.isDigit(this.peek())) {
        stepStr += this.advance();
      }
      const first = parseInt(numStr, 10);
      const step = parseInt(stepStr, 10) || 0;
      return {
        type: SedTokenType.STEP,
        value: `${first}~${step}`,
        first,
        step,
        line: startLine,
        column: startColumn
      };
    }

    return {
      type: SedTokenType.NUMBER,
      value: parseInt(numStr, 10),
      line: startLine,
      column: startColumn
    };
  }

  private readRelativeOffset(): SedToken {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // skip +
    let numStr = "";

    while (this.isDigit(this.peek())) {
      numStr += this.advance();
    }

    const offset = parseInt(numStr, 10) || 0;
    return {
      type: SedTokenType.RELATIVE_OFFSET,
      value: `+${offset}`,
      offset,
      line: startLine,
      column: startColumn
    };
  }

  private readPattern(): SedToken {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // skip opening /
    let pattern = "";
    let inBracket = false;

    while (this.pos < this.input.length) {
      const ch = this.peek();

      // Check for end of pattern (delimiter outside brackets)
      if (ch === "/" && !inBracket) {
        break;
      }

      if (ch === "\\") {
        pattern += this.advance();
        if (this.pos < this.input.length && this.peek() !== "\n") {
          pattern += this.advance();
        }
      } else if (ch === "\n") {
        // Unterminated pattern
        break;
      } else if (ch === "[" && !inBracket) {
        inBracket = true;
        pattern += this.advance();
        // Handle negation and literal ] at start of bracket
        if (this.peek() === "^") {
          pattern += this.advance();
        }
        if (this.peek() === "]") {
          pattern += this.advance(); // ] at start is literal
        }
      } else if (ch === "]" && inBracket) {
        inBracket = false;
        pattern += this.advance();
      } else {
        pattern += this.advance();
      }
    }

    if (this.peek() === "/") {
      this.advance(); // skip closing /
    }

    return {
      type: SedTokenType.PATTERN,
      value: pattern,
      pattern,
      line: startLine,
      column: startColumn
    };
  }

  private readLabelDef(): SedToken {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // skip :

    // Skip optional whitespace after colon (GNU sed allows ': label')
    while (this.peek() === " " || this.peek() === "\t") {
      this.advance();
    }

    // Read label name (until whitespace, semicolon, newline, or brace)
    let label = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (
        ch === " " ||
        ch === "\t" ||
        ch === "\n" ||
        ch === ";" ||
        ch === "}" ||
        ch === "{"
      ) {
        break;
      }
      label += this.advance();
    }

    return {
      type: SedTokenType.LABEL_DEF,
      value: label,
      label,
      line: startLine,
      column: startColumn
    };
  }

  private readCommand(): SedToken {
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.advance();

    switch (ch) {
      case "s":
        return this.readSubstitute(startLine, startColumn);

      case "y":
        return this.readTransliterate(startLine, startColumn);

      case "a":
      case "i":
      case "c":
        return this.readTextCommand(ch, startLine, startColumn);

      case "b":
        return this.readBranch(
          SedTokenType.BRANCH,
          "b",
          startLine,
          startColumn
        );

      case "t":
        return this.readBranch(
          SedTokenType.BRANCH_ON_SUBST,
          "t",
          startLine,
          startColumn
        );

      case "T":
        return this.readBranch(
          SedTokenType.BRANCH_ON_NO_SUBST,
          "T",
          startLine,
          startColumn
        );

      case "r":
        return this.readFileCommand(
          SedTokenType.FILE_READ,
          "r",
          startLine,
          startColumn
        );

      case "R":
        return this.readFileCommand(
          SedTokenType.FILE_READ_LINE,
          "R",
          startLine,
          startColumn
        );

      case "w":
        return this.readFileCommand(
          SedTokenType.FILE_WRITE,
          "w",
          startLine,
          startColumn
        );

      case "W":
        return this.readFileCommand(
          SedTokenType.FILE_WRITE_LINE,
          "W",
          startLine,
          startColumn
        );

      case "e":
        return this.readExecute(startLine, startColumn);

      case "p":
      case "P":
      case "d":
      case "D":
      case "h":
      case "H":
      case "g":
      case "G":
      case "x":
      case "n":
      case "N":
      case "q":
      case "Q":
      case "z":
      case "=":
      case "l":
      case "F":
        return {
          type: SedTokenType.COMMAND,
          value: ch,
          line: startLine,
          column: startColumn
        };

      case "v":
        return this.readVersion(startLine, startColumn);

      default:
        return {
          type: SedTokenType.ERROR,
          value: ch,
          line: startLine,
          column: startColumn
        };
    }
  }

  private readSubstitute(startLine: number, startColumn: number): SedToken {
    // Already consumed 's'
    // Read delimiter
    const delimiter = this.advance();
    if (!delimiter || delimiter === "\n") {
      return {
        type: SedTokenType.ERROR,
        value: "s",
        line: startLine,
        column: startColumn
      };
    }

    // Read pattern (handle bracket expressions where delimiter is literal)
    let pattern = "";
    let inBracket = false;
    while (this.pos < this.input.length) {
      const ch = this.peek();

      // Check for end of pattern (delimiter outside brackets)
      if (ch === delimiter && !inBracket) {
        break;
      }

      if (ch === "\\") {
        this.advance(); // consume backslash
        if (this.pos < this.input.length && this.peek() !== "\n") {
          const escaped = this.peek();
          // Only convert escaped delimiter to literal outside of bracket expressions
          // Inside brackets, keep the backslash for BRE escape sequences
          if (escaped === delimiter && !inBracket) {
            // Escaped delimiter becomes literal delimiter in pattern
            pattern += this.advance();
          } else {
            // Keep backslash + escaped char for other escapes
            pattern += "\\";
            pattern += this.advance();
          }
        } else {
          pattern += "\\";
        }
      } else if (ch === "\n") {
        break;
      } else if (ch === "[" && !inBracket) {
        inBracket = true;
        pattern += this.advance();
        // Handle negation and literal ] at start of bracket
        if (this.peek() === "^") {
          pattern += this.advance();
        }
        if (this.peek() === "]") {
          pattern += this.advance(); // ] at start is literal
        }
      } else if (ch === "]" && inBracket) {
        inBracket = false;
        pattern += this.advance();
      } else {
        pattern += this.advance();
      }
    }

    if (this.peek() !== delimiter) {
      return {
        type: SedTokenType.ERROR,
        value: "unterminated substitution pattern",
        line: startLine,
        column: startColumn
      };
    }
    this.advance(); // skip middle delimiter

    // Read replacement
    let replacement = "";
    while (this.pos < this.input.length && this.peek() !== delimiter) {
      if (this.peek() === "\\") {
        this.advance(); // consume first backslash
        if (this.pos < this.input.length) {
          const next = this.peek();
          if (next === "\\") {
            // Double backslash - check what follows
            this.advance(); // consume second backslash
            if (this.pos < this.input.length && this.peek() === "\n") {
              // \\<newline> = escaped newline (literal newline in output)
              // This is how BusyBox sed handles multi-line replacements
              replacement += "\n";
              this.advance();
            } else {
              // \\\\ = literal backslash
              replacement += "\\";
            }
          } else if (next === "\n") {
            // \<newline> in replacement: include the newline as literal
            replacement += "\n";
            this.advance();
          } else {
            // Keep the backslash and following character
            replacement += `\\${this.advance()}`;
          }
        } else {
          replacement += "\\";
        }
      } else if (this.peek() === "\n") {
        break;
      } else {
        replacement += this.advance();
      }
    }

    // Closing delimiter is optional for last part
    if (this.peek() === delimiter) {
      this.advance();
    }

    // Read flags
    let flags = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (
        ch === "g" ||
        ch === "i" ||
        ch === "p" ||
        ch === "I" ||
        this.isDigit(ch)
      ) {
        flags += this.advance();
      } else {
        break;
      }
    }

    return {
      type: SedTokenType.SUBSTITUTE,
      value: `s${delimiter}${pattern}${delimiter}${replacement}${delimiter}${flags}`,
      pattern,
      replacement,
      flags,
      line: startLine,
      column: startColumn
    };
  }

  private readTransliterate(startLine: number, startColumn: number): SedToken {
    // Already consumed 'y'
    const delimiter = this.advance();
    if (!delimiter || delimiter === "\n") {
      return {
        type: SedTokenType.ERROR,
        value: "y",
        line: startLine,
        column: startColumn
      };
    }

    // Read source characters
    const source = this.readEscapedString(delimiter);
    if (source === null || this.peek() !== delimiter) {
      return {
        type: SedTokenType.ERROR,
        value: "unterminated transliteration source",
        line: startLine,
        column: startColumn
      };
    }
    this.advance(); // skip middle delimiter

    // Read dest characters
    const dest = this.readEscapedString(delimiter);
    if (dest === null || this.peek() !== delimiter) {
      return {
        type: SedTokenType.ERROR,
        value: "unterminated transliteration dest",
        line: startLine,
        column: startColumn
      };
    }
    this.advance(); // skip closing delimiter

    // Check for extra text after y command - only ; } newline or EOF allowed
    // Whitespace followed by more text is an error
    let nextChar = this.peek();
    // Skip whitespace but track if we had any
    while (nextChar === " " || nextChar === "\t") {
      this.advance();
      nextChar = this.peek();
    }
    // After y command, only command separators or EOF allowed
    if (
      nextChar !== "" &&
      nextChar !== ";" &&
      nextChar !== "\n" &&
      nextChar !== "}"
    ) {
      return {
        type: SedTokenType.ERROR,
        value: "extra text at the end of a transform command",
        line: startLine,
        column: startColumn
      };
    }

    return {
      type: SedTokenType.TRANSLITERATE,
      value: `y${delimiter}${source}${delimiter}${dest}${delimiter}`,
      source,
      dest,
      line: startLine,
      column: startColumn
    };
  }

  private readTextCommand(
    cmd: string,
    startLine: number,
    startColumn: number
  ): SedToken {
    // a, i, c commands can be followed by:
    // 1. a\ followed by newline then text (traditional)
    // 2. a text (GNU extension one-liner, text after space)
    // 3. a\text (backslash followed by text on same line)

    let hasBackslash = false;
    // Traditional a\ syntax: only consume backslash if followed by newline or space
    if (
      this.peek() === "\\" &&
      this.pos + 1 < this.input.length &&
      (this.input[this.pos + 1] === "\n" ||
        this.input[this.pos + 1] === " " ||
        this.input[this.pos + 1] === "\t")
    ) {
      hasBackslash = true;
      this.advance();
    }

    // Skip optional space after command or backslash
    if (this.peek() === " " || this.peek() === "\t") {
      this.advance();
    }

    // Check for \ at start of text to preserve leading spaces (GNU extension)
    // e.g., "a \   text" preserves "   text"
    // Only consume backslash if followed by space, otherwise it's an escape sequence
    if (
      this.peek() === "\\" &&
      this.pos + 1 < this.input.length &&
      (this.input[this.pos + 1] === " " || this.input[this.pos + 1] === "\t")
    ) {
      this.advance();
    }

    // If we have backslash followed by newline, text is on next line(s)
    if (hasBackslash && this.peek() === "\n") {
      this.advance(); // consume newline
    }

    // Read text, handling multi-line continuation and escape sequences
    let text = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();

      if (ch === "\n") {
        // Check if previous char was backslash for continuation
        if (text.endsWith("\\")) {
          // Continuation: remove backslash and add newline
          text = `${text.slice(0, -1)}\n`;
          this.advance();
          continue;
        }
        // End of text
        break;
      }

      // Handle escape sequences in text commands (\n, \t, \r)
      if (ch === "\\" && this.pos + 1 < this.input.length) {
        const next = this.input[this.pos + 1];
        if (next === "n") {
          text += "\n";
          this.advance();
          this.advance();
          continue;
        }
        if (next === "t") {
          text += "\t";
          this.advance();
          this.advance();
          continue;
        }
        if (next === "r") {
          text += "\r";
          this.advance();
          this.advance();
          continue;
        }
      }

      text += this.advance();
    }

    // Don't trim text - escape sequences like \t at the start are intentional
    return {
      type: SedTokenType.TEXT_CMD,
      value: cmd,
      text,
      line: startLine,
      column: startColumn
    };
  }

  private readBranch(
    type: SedTokenType,
    cmd: string,
    startLine: number,
    startColumn: number
  ): SedToken {
    // Skip whitespace
    while (this.peek() === " " || this.peek() === "\t") {
      this.advance();
    }

    // Read optional label
    let label = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (
        ch === " " ||
        ch === "\t" ||
        ch === "\n" ||
        ch === ";" ||
        ch === "}" ||
        ch === "{"
      ) {
        break;
      }
      label += this.advance();
    }

    return {
      type,
      value: cmd,
      label: label || undefined,
      line: startLine,
      column: startColumn
    };
  }

  private readVersion(startLine: number, startColumn: number): SedToken {
    // Skip whitespace
    while (this.peek() === " " || this.peek() === "\t") {
      this.advance();
    }

    // Read optional version string (e.g., "4.5.3")
    let version = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (
        ch === " " ||
        ch === "\t" ||
        ch === "\n" ||
        ch === ";" ||
        ch === "}" ||
        ch === "{"
      ) {
        break;
      }
      version += this.advance();
    }

    return {
      type: SedTokenType.VERSION,
      value: "v",
      label: version || undefined, // Reuse label field for version string
      line: startLine,
      column: startColumn
    };
  }

  private readFileCommand(
    type: SedTokenType,
    cmd: string,
    startLine: number,
    startColumn: number
  ): SedToken {
    // Skip whitespace (but not newline)
    while (this.peek() === " " || this.peek() === "\t") {
      this.advance();
    }

    // Read filename until newline or semicolon
    let filename = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "\n" || ch === ";") {
        break;
      }
      filename += this.advance();
    }

    return {
      type,
      value: cmd,
      filename: filename.trim(),
      line: startLine,
      column: startColumn
    };
  }

  private readExecute(startLine: number, startColumn: number): SedToken {
    // Skip whitespace
    while (this.peek() === " " || this.peek() === "\t") {
      this.advance();
    }

    // Read optional command until newline or semicolon
    let command = "";
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (ch === "\n" || ch === ";") {
        break;
      }
      command += this.advance();
    }

    return {
      type: SedTokenType.EXECUTE,
      value: "e",
      command: command.trim() || undefined,
      line: startLine,
      column: startColumn
    };
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }
}
