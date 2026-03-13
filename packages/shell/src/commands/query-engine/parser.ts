/**
 * Query expression parser
 *
 * Tokenizes and parses jq-style filter expressions into an AST.
 * Used by jq, yq, and other query-based commands.
 */

// Re-export types from parser-types.ts
export type {
  ArrayNode,
  AstNode,
  BinaryOpNode,
  BreakNode,
  CallNode,
  CommaNode,
  CondNode,
  DefNode,
  DestructurePattern,
  FieldNode,
  ForeachNode,
  IdentityNode,
  IndexNode,
  IterateNode,
  LabelNode,
  LiteralNode,
  ObjectNode,
  OptionalNode,
  ParenNode,
  PipeNode,
  RecurseNode,
  ReduceNode,
  SliceNode,
  StringInterpNode,
  Token,
  TokenType,
  TryNode,
  UnaryOpNode,
  UpdateOpNode,
  VarBindNode,
  VarRefNode
} from "./parser-types";

import type {
  AstNode,
  BinaryOpNode,
  CondNode,
  DestructurePattern,
  ObjectNode,
  StringInterpNode,
  Token,
  TokenType,
  UpdateOpNode
} from "./parser-types";

// ============================================================================
// Tokenizer
// ============================================================================

// Use Map instead of plain object to avoid prototype pollution
// (e.g., "__proto__" lookup returning Object.prototype.__proto__)
const KEYWORDS: Map<string, TokenType> = new Map([
  ["and", "AND"],
  ["or", "OR"],
  ["not", "NOT"],
  ["if", "IF"],
  ["then", "THEN"],
  ["elif", "ELIF"],
  ["else", "ELSE"],
  ["end", "END"],
  ["as", "AS"],
  ["try", "TRY"],
  ["catch", "CATCH"],
  ["true", "TRUE"],
  ["false", "FALSE"],
  ["null", "NULL"],
  ["reduce", "REDUCE"],
  ["foreach", "FOREACH"],
  ["label", "LABEL"],
  ["break", "BREAK"],
  ["def", "DEF"]
]);

const KEYWORD_TOKEN_TYPES: Set<TokenType> = new Set(KEYWORDS.values());

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  const peek = (offset = 0) => input[pos + offset];
  const advance = () => input[pos++];
  const isEof = () => pos >= input.length;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isAlpha = (c: string) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  const isAlnum = (c: string) => isAlpha(c) || isDigit(c);

  while (!isEof()) {
    const start = pos;
    const c = advance();

    // Whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      continue;
    }

    // Comments
    if (c === "#") {
      while (!isEof() && peek() !== "\n") advance();
      continue;
    }

    // Two-character operators
    if (c === "." && peek() === ".") {
      advance();
      tokens.push({ type: "DOTDOT", pos: start });
      continue;
    }
    if (c === "=" && peek() === "=") {
      advance();
      tokens.push({ type: "EQ", pos: start });
      continue;
    }
    if (c === "!" && peek() === "=") {
      advance();
      tokens.push({ type: "NE", pos: start });
      continue;
    }
    if (c === "<" && peek() === "=") {
      advance();
      tokens.push({ type: "LE", pos: start });
      continue;
    }
    if (c === ">" && peek() === "=") {
      advance();
      tokens.push({ type: "GE", pos: start });
      continue;
    }
    if (c === "/" && peek() === "/") {
      advance();
      if (peek() === "=") {
        advance();
        tokens.push({ type: "UPDATE_ALT", pos: start });
      } else {
        tokens.push({ type: "ALT", pos: start });
      }
      continue;
    }
    if (c === "+" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_ADD", pos: start });
      continue;
    }
    if (c === "-" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_SUB", pos: start });
      continue;
    }
    if (c === "*" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_MUL", pos: start });
      continue;
    }
    if (c === "/" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_DIV", pos: start });
      continue;
    }
    if (c === "%" && peek() === "=") {
      advance();
      tokens.push({ type: "UPDATE_MOD", pos: start });
      continue;
    }
    if (c === "=" && peek() !== "=") {
      tokens.push({ type: "ASSIGN", pos: start });
      continue;
    }

    // Single-character tokens
    if (c === ".") {
      tokens.push({ type: "DOT", pos: start });
      continue;
    }
    if (c === "|") {
      if (peek() === "=") {
        advance();
        tokens.push({ type: "UPDATE_PIPE", pos: start });
      } else {
        tokens.push({ type: "PIPE", pos: start });
      }
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "COMMA", pos: start });
      continue;
    }
    if (c === ":") {
      tokens.push({ type: "COLON", pos: start });
      continue;
    }
    if (c === ";") {
      tokens.push({ type: "SEMICOLON", pos: start });
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "LPAREN", pos: start });
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "RPAREN", pos: start });
      continue;
    }
    if (c === "[") {
      tokens.push({ type: "LBRACKET", pos: start });
      continue;
    }
    if (c === "]") {
      tokens.push({ type: "RBRACKET", pos: start });
      continue;
    }
    if (c === "{") {
      tokens.push({ type: "LBRACE", pos: start });
      continue;
    }
    if (c === "}") {
      tokens.push({ type: "RBRACE", pos: start });
      continue;
    }
    if (c === "?") {
      tokens.push({ type: "QUESTION", pos: start });
      continue;
    }
    if (c === "+") {
      tokens.push({ type: "PLUS", pos: start });
      continue;
    }
    if (c === "-") {
      // Always tokenize as MINUS - let parser handle unary minus
      tokens.push({ type: "MINUS", pos: start });
      continue;
    }
    if (c === "*") {
      tokens.push({ type: "STAR", pos: start });
      continue;
    }
    if (c === "/") {
      tokens.push({ type: "SLASH", pos: start });
      continue;
    }
    if (c === "%") {
      tokens.push({ type: "PERCENT", pos: start });
      continue;
    }
    if (c === "<") {
      tokens.push({ type: "LT", pos: start });
      continue;
    }
    if (c === ">") {
      tokens.push({ type: "GT", pos: start });
      continue;
    }

    // Numbers
    if (isDigit(c)) {
      let num = c;
      while (
        !isEof() &&
        (isDigit(peek()) || peek() === "." || peek() === "e" || peek() === "E")
      ) {
        if (
          (peek() === "e" || peek() === "E") &&
          (input[pos + 1] === "+" || input[pos + 1] === "-")
        ) {
          num += advance();
          num += advance();
        } else {
          num += advance();
        }
      }
      tokens.push({ type: "NUMBER", value: Number(num), pos: start });
      continue;
    }

    // Strings
    if (c === '"') {
      let str = "";
      while (!isEof() && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          if (isEof()) break;
          const escaped = advance();
          switch (escaped) {
            case "n":
              str += "\n";
              break;
            case "r":
              str += "\r";
              break;
            case "t":
              str += "\t";
              break;
            case "\\":
              str += "\\";
              break;
            case '"':
              str += '"';
              break;
            case "(":
              str += "\\(";
              break; // Keep for string interpolation
            default:
              str += escaped;
          }
        } else {
          str += advance();
        }
      }
      if (!isEof()) advance(); // closing quote
      tokens.push({ type: "STRING", value: str, pos: start });
      continue;
    }

    // Identifiers and keywords
    if (isAlpha(c) || c === "$" || c === "@") {
      let ident = c;
      while (!isEof() && isAlnum(peek())) {
        ident += advance();
      }
      const keyword = KEYWORDS.get(ident);
      if (keyword) {
        tokens.push({ type: keyword, value: ident, pos: start });
      } else {
        tokens.push({ type: "IDENT", value: ident, pos: start });
      }
      continue;
    }

    throw new Error(`Unexpected character '${c}' at position ${start}`);
  }

  tokens.push({ type: "EOF", pos: pos });
  return tokens;
}

// Parser
// ============================================================================

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? { type: "EOF", pos: -1 };
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(...types: TokenType[]): Token | null {
    for (const type of types) {
      if (this.check(type)) {
        return this.advance();
      }
    }
    return null;
  }

  private expect(type: TokenType, msg: string): Token {
    if (!this.check(type)) {
      throw new Error(
        `${msg} at position ${this.peek().pos}, got ${this.peek().type}`
      );
    }
    return this.advance();
  }

  private isFieldNameAfterDot(dotOffset = 0): boolean {
    const dot = this.peek(dotOffset);
    const next = this.peek(dotOffset + 1);
    if (next.type === "STRING") return true;
    if (next.type === "IDENT" || KEYWORD_TOKEN_TYPES.has(next.type)) {
      return next.pos === dot.pos + 1;
    }
    return false;
  }

  private isIdentLike(): boolean {
    const t = this.peek().type;
    return t === "IDENT" || KEYWORD_TOKEN_TYPES.has(t);
  }

  private consumeFieldNameAfterDot(dotToken: Token): string | null {
    const next = this.peek();
    if (next.type === "STRING") {
      return this.advance().value as string;
    }
    if (
      (next.type === "IDENT" || KEYWORD_TOKEN_TYPES.has(next.type)) &&
      next.pos === dotToken.pos + 1
    ) {
      return this.advance().value as string;
    }
    return null;
  }

  parse(): AstNode {
    const expr = this.parseExpr();
    if (!this.check("EOF")) {
      throw new Error(
        `Unexpected token ${this.peek().type} at position ${this.peek().pos}`
      );
    }
    return expr;
  }

  private parseExpr(): AstNode {
    return this.parsePipe();
  }

  /**
   * Parse a destructuring pattern for variable binding
   * Patterns can be:
   *   $var              - simple variable
   *   [$a, $b, ...]     - array destructuring
   *   {key: $a, ...}    - object destructuring
   *   {$a, ...}         - shorthand object destructuring (key same as var name)
   */
  private parsePattern(): DestructurePattern {
    // Array pattern: [$a, $b, ...]
    if (this.match("LBRACKET")) {
      const elements: DestructurePattern[] = [];
      if (!this.check("RBRACKET")) {
        elements.push(this.parsePattern());
        while (this.match("COMMA")) {
          if (this.check("RBRACKET")) break;
          elements.push(this.parsePattern());
        }
      }
      this.expect("RBRACKET", "Expected ']' after array pattern");
      return { type: "array", elements };
    }

    // Object pattern: {key: $a, $b, ...}
    if (this.match("LBRACE")) {
      const fields: { key: string | AstNode; pattern: DestructurePattern }[] =
        [];
      if (!this.check("RBRACE")) {
        // Parse first field
        fields.push(this.parsePatternField());
        while (this.match("COMMA")) {
          if (this.check("RBRACE")) break;
          fields.push(this.parsePatternField());
        }
      }
      this.expect("RBRACE", "Expected '}' after object pattern");
      return { type: "object", fields };
    }

    // Simple variable: $name
    const tok = this.expect("IDENT", "Expected variable name in pattern");
    const name = tok.value as string;
    if (!name.startsWith("$")) {
      throw new Error(`Variable name must start with $ at position ${tok.pos}`);
    }
    return { type: "var", name };
  }

  /**
   * Parse a single field in an object destructuring pattern
   */
  private parsePatternField(): {
    key: string | AstNode;
    pattern: DestructurePattern;
    keyVar?: string;
  } {
    // Check for computed key: (expr): $pattern
    if (this.match("LPAREN")) {
      const keyExpr = this.parseExpr();
      this.expect("RPAREN", "Expected ')' after computed key");
      this.expect("COLON", "Expected ':' after computed key");
      const pattern = this.parsePattern();
      return { key: keyExpr, pattern };
    }

    // Check for shorthand: $name or $name:pattern
    const tok = this.peek();
    if (tok.type === "IDENT" || KEYWORD_TOKEN_TYPES.has(tok.type)) {
      const name = tok.value as string;
      if (name.startsWith("$")) {
        this.advance();
        // Check for $name:pattern (e.g., $b:[$c, $d] means key="b", pattern=[$c,$d], keyVar=$b)
        if (this.match("COLON")) {
          const pattern = this.parsePattern();
          // Also bind $name to the whole value at this key
          return { key: name.slice(1), pattern, keyVar: name };
        }
        // Shorthand: $foo is equivalent to foo: $foo
        return { key: name.slice(1), pattern: { type: "var", name } };
      }
      // Regular key: name
      this.advance();
      if (this.match("COLON")) {
        const pattern = this.parsePattern();
        return { key: name, pattern };
      }
      // If no colon, it's a shorthand for key: $key
      return { key: name, pattern: { type: "var", name: `$${name}` } };
    }

    throw new Error(
      `Expected field name in object pattern at position ${tok.pos}`
    );
  }

  private parsePipe(): AstNode {
    let left = this.parseComma();
    while (this.match("PIPE")) {
      const right = this.parseComma();
      left = { type: "Pipe", left, right };
    }
    return left;
  }

  private parseComma(): AstNode {
    let left = this.parseVarBind();
    while (this.match("COMMA")) {
      const right = this.parseVarBind();
      left = { type: "Comma", left, right };
    }
    return left;
  }

  private parseVarBind(): AstNode {
    const expr = this.parseUpdate();
    if (this.match("AS")) {
      // Parse pattern (can be $var, [$a, $b], {key: $a}, etc.)
      const pattern = this.parsePattern();

      // Check for alternative patterns: ?// PATTERN ?// PATTERN ...
      const alternatives: DestructurePattern[] = [];
      while (this.check("QUESTION") && this.peekAhead(1)?.type === "ALT") {
        this.advance(); // consume QUESTION
        this.advance(); // consume ALT
        alternatives.push(this.parsePattern());
      }

      this.expect("PIPE", "Expected '|' after variable binding");
      const body = this.parseExpr();

      // For simple variable patterns without alternatives
      if (pattern.type === "var" && alternatives.length === 0) {
        return { type: "VarBind", name: pattern.name, value: expr, body };
      }

      // For complex patterns or patterns with alternatives
      return {
        type: "VarBind",
        name: pattern.type === "var" ? pattern.name : "",
        value: expr,
        body,
        pattern: pattern.type !== "var" ? pattern : undefined,
        alternatives: alternatives.length > 0 ? alternatives : undefined
      };
    }
    return expr;
  }

  /**
   * Peek at a token N positions ahead (0 = current, 1 = next, etc.)
   */
  private peekAhead(
    n: number
  ): { type: TokenType; pos: number; value?: unknown } | undefined {
    const idx = this.pos + n;
    return idx < this.tokens.length ? this.tokens[idx] : undefined;
  }

  private parseUpdate(): AstNode {
    const left = this.parseAlt();
    // Use Map to avoid prototype pollution
    const opMap = new Map<string, UpdateOpNode["op"]>([
      ["ASSIGN", "="],
      ["UPDATE_ADD", "+="],
      ["UPDATE_SUB", "-="],
      ["UPDATE_MUL", "*="],
      ["UPDATE_DIV", "/="],
      ["UPDATE_MOD", "%="],
      ["UPDATE_ALT", "//="],
      ["UPDATE_PIPE", "|="]
    ]);
    const tok = this.match(
      "ASSIGN",
      "UPDATE_ADD",
      "UPDATE_SUB",
      "UPDATE_MUL",
      "UPDATE_DIV",
      "UPDATE_MOD",
      "UPDATE_ALT",
      "UPDATE_PIPE"
    );
    if (tok) {
      const value = this.parseVarBind();
      const op = opMap.get(tok.type);
      if (op) {
        return { type: "UpdateOp", op, path: left, value };
      }
    }
    return left;
  }

  private parseAlt(): AstNode {
    let left = this.parseOr();
    while (this.match("ALT")) {
      const right = this.parseOr();
      left = { type: "BinaryOp", op: "//", left, right };
    }
    return left;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.match("OR")) {
      const right = this.parseAnd();
      left = { type: "BinaryOp", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.match("AND")) {
      const right = this.parseNot();
      left = { type: "BinaryOp", op: "and", left, right };
    }
    return left;
  }

  private parseNot(): AstNode {
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    let left = this.parseAddSub();
    // Use Map to avoid prototype pollution
    const opMap = new Map<string, BinaryOpNode["op"]>([
      ["EQ", "=="],
      ["NE", "!="],
      ["LT", "<"],
      ["LE", "<="],
      ["GT", ">"],
      ["GE", ">="]
    ]);
    const tok = this.match("EQ", "NE", "LT", "LE", "GT", "GE");
    if (tok) {
      const op = opMap.get(tok.type);
      if (op) {
        const right = this.parseAddSub();
        left = { type: "BinaryOp", op, left, right };
      }
    }
    return left;
  }

  private parseAddSub(): AstNode {
    let left = this.parseMulDiv();
    while (true) {
      if (this.match("PLUS")) {
        const right = this.parseMulDiv();
        left = { type: "BinaryOp", op: "+", left, right };
      } else if (this.match("MINUS")) {
        const right = this.parseMulDiv();
        left = { type: "BinaryOp", op: "-", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseMulDiv(): AstNode {
    let left = this.parseUnary();
    while (true) {
      if (this.match("STAR")) {
        const right = this.parseUnary();
        left = { type: "BinaryOp", op: "*", left, right };
      } else if (this.match("SLASH")) {
        const right = this.parseUnary();
        left = { type: "BinaryOp", op: "/", left, right };
      } else if (this.match("PERCENT")) {
        const right = this.parseUnary();
        left = { type: "BinaryOp", op: "%", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.match("MINUS")) {
      const operand = this.parseUnary();
      return { type: "UnaryOp", op: "-", operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let expr = this.parsePrimary();

    while (true) {
      if (this.match("QUESTION")) {
        expr = { type: "Optional", expr };
      } else if (this.check("DOT") && this.isFieldNameAfterDot()) {
        this.advance(); // consume DOT
        const token = this.advance();
        const name = token.value as string;
        expr = { type: "Field", name, base: expr };
      } else if (this.check("LBRACKET")) {
        this.advance();
        if (this.match("RBRACKET")) {
          expr = { type: "Iterate", base: expr };
        } else if (this.check("COLON")) {
          this.advance();
          const end = this.check("RBRACKET") ? undefined : this.parseExpr();
          this.expect("RBRACKET", "Expected ']'");
          expr = { type: "Slice", end, base: expr };
        } else {
          const indexExpr = this.parseExpr();
          if (this.match("COLON")) {
            const end = this.check("RBRACKET") ? undefined : this.parseExpr();
            this.expect("RBRACKET", "Expected ']'");
            expr = { type: "Slice", start: indexExpr, end, base: expr };
          } else {
            this.expect("RBRACKET", "Expected ']'");
            expr = { type: "Index", index: indexExpr, base: expr };
          }
        }
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimary(): AstNode {
    // Recursive descent (..)
    if (this.match("DOTDOT")) {
      return { type: "Recurse" };
    }

    // Identity or field access starting with dot
    if (this.check("DOT")) {
      const dotToken = this.advance();
      // Check for .[] or .[n] or .[n:m]
      if (this.check("LBRACKET")) {
        this.advance();
        if (this.match("RBRACKET")) {
          return { type: "Iterate" };
        }
        if (this.check("COLON")) {
          this.advance();
          const end = this.check("RBRACKET") ? undefined : this.parseExpr();
          this.expect("RBRACKET", "Expected ']'");
          return { type: "Slice", end };
        }
        const indexExpr = this.parseExpr();
        if (this.match("COLON")) {
          const end = this.check("RBRACKET") ? undefined : this.parseExpr();
          this.expect("RBRACKET", "Expected ']'");
          return { type: "Slice", start: indexExpr, end };
        }
        this.expect("RBRACKET", "Expected ']'");
        return { type: "Index", index: indexExpr };
      }
      // .field or ."quoted-field" (keywords like .label are valid field names)
      const fieldName = this.consumeFieldNameAfterDot(dotToken);
      if (fieldName !== null) {
        return { type: "Field", name: fieldName };
      }
      // Just identity
      return { type: "Identity" };
    }

    // Literals
    if (this.match("TRUE")) {
      return { type: "Literal", value: true };
    }
    if (this.match("FALSE")) {
      return { type: "Literal", value: false };
    }
    if (this.match("NULL")) {
      return { type: "Literal", value: null };
    }
    if (this.check("NUMBER")) {
      const tok = this.advance();
      return { type: "Literal", value: tok.value };
    }
    if (this.check("STRING")) {
      const tok = this.advance();
      const str = tok.value as string;
      // Check for string interpolation
      if (str.includes("\\(")) {
        return this.parseStringInterpolation(str);
      }
      return { type: "Literal", value: str };
    }

    // Array construction
    if (this.match("LBRACKET")) {
      if (this.match("RBRACKET")) {
        return { type: "Array" };
      }
      const elements = this.parseExpr();
      this.expect("RBRACKET", "Expected ']'");
      return { type: "Array", elements };
    }

    // Object construction
    if (this.match("LBRACE")) {
      return this.parseObjectConstruction();
    }

    // Parentheses
    if (this.match("LPAREN")) {
      const expr = this.parseExpr();
      this.expect("RPAREN", "Expected ')'");
      return { type: "Paren", expr };
    }

    // if-then-else
    if (this.match("IF")) {
      return this.parseIf();
    }

    // try-catch
    if (this.match("TRY")) {
      const body = this.parsePostfix();
      let catchExpr: AstNode | undefined;
      if (this.match("CATCH")) {
        catchExpr = this.parsePostfix();
      }
      return { type: "Try", body, catch: catchExpr };
    }

    // reduce EXPR as $VAR (INIT; UPDATE)
    if (this.match("REDUCE")) {
      // Use parseAddSub to handle expressions like .[] / .[] or .[] + .[] before 'as'
      const expr = this.parseAddSub();
      this.expect("AS", "Expected 'as' after reduce expression");
      const pattern = this.parsePattern();
      this.expect("LPAREN", "Expected '(' after variable");
      const init = this.parseExpr();
      this.expect("SEMICOLON", "Expected ';' after init expression");
      const update = this.parseExpr();
      this.expect("RPAREN", "Expected ')' after update expression");
      // For simple variable, use varName; for complex patterns, use pattern
      const varName = pattern.type === "var" ? pattern.name : "";
      return {
        type: "Reduce",
        expr,
        varName,
        init,
        update,
        pattern: pattern.type !== "var" ? pattern : undefined
      };
    }

    // foreach EXPR as $VAR (INIT; UPDATE) or (INIT; UPDATE; EXTRACT)
    if (this.match("FOREACH")) {
      // Use parseAddSub to handle expressions like .[] / .[] or .[] + .[] before 'as'
      const expr = this.parseAddSub();
      this.expect("AS", "Expected 'as' after foreach expression");
      const pattern = this.parsePattern();
      this.expect("LPAREN", "Expected '(' after variable");
      const init = this.parseExpr();
      this.expect("SEMICOLON", "Expected ';' after init expression");
      const update = this.parseExpr();
      let extract: AstNode | undefined;
      if (this.match("SEMICOLON")) {
        extract = this.parseExpr();
      }
      this.expect("RPAREN", "Expected ')' after expressions");
      // For simple variable, use varName; for complex patterns, use pattern
      const varName = pattern.type === "var" ? pattern.name : "";
      return {
        type: "Foreach",
        expr,
        varName,
        init,
        update,
        extract,
        pattern: pattern.type !== "var" ? pattern : undefined
      };
    }

    // not as a standalone filter (when used as a function, not unary operator)

    // label $NAME | BODY
    if (this.match("LABEL")) {
      const labelToken = this.expect(
        "IDENT",
        "Expected label name (e.g., $out)"
      );
      const labelName = labelToken.value as string;
      if (!labelName.startsWith("$")) {
        throw new Error(
          `Label name must start with $ at position ${labelToken.pos}`
        );
      }
      this.expect("PIPE", "Expected '|' after label name");
      const labelBody = this.parseExpr();
      return { type: "Label", name: labelName, body: labelBody };
    }

    // break $NAME
    if (this.match("BREAK")) {
      const breakToken = this.expect(
        "IDENT",
        "Expected label name to break to"
      );
      const breakLabel = breakToken.value as string;
      if (!breakLabel.startsWith("$")) {
        throw new Error(
          `Break label must start with $ at position ${breakToken.pos}`
        );
      }
      return { type: "Break", name: breakLabel };
    }

    // def NAME: BODY; or def NAME(ARGS): BODY;
    if (this.match("DEF")) {
      const nameToken = this.expect(
        "IDENT",
        "Expected function name after def"
      );
      const funcName = nameToken.value as string;
      const params: string[] = [];

      // Check for parameters
      if (this.match("LPAREN")) {
        if (!this.check("RPAREN")) {
          // Parse first parameter
          const firstParam = this.expect("IDENT", "Expected parameter name");
          params.push(firstParam.value as string);
          // Parse remaining parameters (semicolon-separated)
          while (this.match("SEMICOLON")) {
            const param = this.expect("IDENT", "Expected parameter name");
            params.push(param.value as string);
          }
        }
        this.expect("RPAREN", "Expected ')' after parameters");
      }

      this.expect("COLON", "Expected ':' after function name");
      const funcBody = this.parseExpr();
      this.expect("SEMICOLON", "Expected ';' after function body");
      const body = this.parseExpr();

      return { type: "Def", name: funcName, params, funcBody, body };
    }

    if (this.match("NOT")) {
      return { type: "Call", name: "not", args: [] };
    }

    // Variable reference or function call
    if (this.check("IDENT")) {
      const tok = this.advance();
      const name = tok.value as string;

      // Variable reference
      if (name.startsWith("$")) {
        return { type: "VarRef", name };
      }

      // Function call with args
      if (this.match("LPAREN")) {
        const args: AstNode[] = [];
        if (!this.check("RPAREN")) {
          args.push(this.parseExpr());
          while (this.match("SEMICOLON")) {
            args.push(this.parseExpr());
          }
        }
        this.expect("RPAREN", "Expected ')'");
        return { type: "Call", name, args };
      }

      // Builtin without parens
      return { type: "Call", name, args: [] };
    }

    throw new Error(
      `Unexpected token ${this.peek().type} at position ${this.peek().pos}`
    );
  }

  private parseObjectConstruction(): ObjectNode {
    const entries: ObjectNode["entries"] = [];

    if (!this.check("RBRACE")) {
      do {
        let key: string | AstNode;
        let value: AstNode;

        // Check for ({(.key): .value}) dynamic key
        if (this.match("LPAREN")) {
          key = this.parseExpr();
          this.expect("RPAREN", "Expected ')'");
          this.expect("COLON", "Expected ':'");
          value = this.parseObjectValue();
        } else if (this.isIdentLike()) {
          const ident = this.advance().value as string;
          if (this.match("COLON")) {
            // {key: value}
            key = ident;
            value = this.parseObjectValue();
          } else {
            // {key} shorthand for {key: .key}
            key = ident;
            value = { type: "Field", name: ident };
          }
        } else if (this.check("STRING")) {
          key = this.advance().value as string;
          this.expect("COLON", "Expected ':'");
          value = this.parseObjectValue();
        } else {
          throw new Error(`Expected object key at position ${this.peek().pos}`);
        }

        entries.push({ key, value });
      } while (this.match("COMMA"));
    }

    this.expect("RBRACE", "Expected '}'");
    return { type: "Object", entries };
  }

  // Parse object value - allows pipes but stops at comma or rbrace
  // Uses parsePipe level to avoid consuming comma as part of expression
  private parseObjectValue(): AstNode {
    let left = this.parseVarBind();
    while (this.match("PIPE")) {
      const right = this.parseVarBind();
      left = { type: "Pipe", left, right };
    }
    return left;
  }

  private parseIf(): CondNode {
    const cond = this.parseExpr();
    this.expect("THEN", "Expected 'then'");
    const then = this.parseExpr();

    const elifs: CondNode["elifs"] = [];
    while (this.match("ELIF")) {
      const elifCond = this.parseExpr();
      this.expect("THEN", "Expected 'then' after elif");
      const elifThen = this.parseExpr();
      // biome-ignore lint/suspicious/noThenProperty: jq AST node
      elifs.push({ cond: elifCond, then: elifThen });
    }

    let elseExpr: AstNode | undefined;
    if (this.match("ELSE")) {
      elseExpr = this.parseExpr();
    }

    this.expect("END", "Expected 'end'");
    return { type: "Cond", cond, then, elifs, else: elseExpr };
  }

  private parseStringInterpolation(str: string): StringInterpNode {
    const parts: (string | AstNode)[] = [];
    let current = "";
    let i = 0;

    while (i < str.length) {
      if (str[i] === "\\" && str[i + 1] === "(") {
        if (current) {
          parts.push(current);
          current = "";
        }
        i += 2;
        // Find matching paren
        let depth = 1;
        let exprStr = "";
        while (i < str.length && depth > 0) {
          if (str[i] === "(") depth++;
          else if (str[i] === ")") depth--;
          if (depth > 0) exprStr += str[i];
          i++;
        }
        const tokens = tokenize(exprStr);
        const parser = new Parser(tokens);
        parts.push(parser.parse());
      } else {
        current += str[i];
        i++;
      }
    }

    if (current) {
      parts.push(current);
    }

    return { type: "StringInterp", parts };
  }
}

// ============================================================================
// Convenience function
// ============================================================================

export function parse(input: string): AstNode {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parse();
}
