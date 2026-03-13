/**
 * Recursive Descent Parser for Bash Scripts
 *
 * This parser consumes tokens from the lexer and produces an AST.
 * It follows the bash grammar structure for correctness.
 *
 * Grammar (simplified):
 *   script       ::= statement*
 *   statement    ::= pipeline ((&&|'||') pipeline)*  [&]
 *   pipeline     ::= [!] command (| command)*
 *   command      ::= simple_command | compound_command | function_def
 *   simple_cmd   ::= (assignment)* [word] (word)* (redirection)*
 *   compound_cmd ::= if | for | while | until | case | subshell | group | (( | [[
 */

import {
  type ArithmeticCommandNode,
  type ArithmeticExpansionPart,
  type ArithmeticExpressionNode,
  AST,
  type CommandNode,
  type CommandSubstitutionPart,
  type CompoundCommandNode,
  type ConditionalCommandNode,
  type FunctionDefNode,
  type PipelineNode,
  type RedirectionNode,
  type ScriptNode,
  type StatementNode,
  type SubshellNode,
  type WordNode
} from "../ast/types";
import * as ArithParser from "./arithmetic-parser";
import * as CmdParser from "./command-parser";
import * as CompoundParser from "./compound-parser";
import * as CondParser from "./conditional-parser";
import * as ExpParser from "./expansion-parser";
import { Lexer, type LexerOptions, type Token, TokenType } from "./lexer";
import {
  isDollarDparenSubshell as isDollarDparenSubshellHelper,
  parseBacktickSubstitutionFromString,
  parseCommandSubstitutionFromString
} from "./parser-substitution";
import {
  MAX_INPUT_SIZE,
  MAX_PARSE_ITERATIONS,
  MAX_PARSER_DEPTH,
  MAX_TOKENS,
  ParseException
} from "./types";

export type { ParseError } from "./types";
// Re-export for backwards compatibility
export { ParseException } from "./types";

/**
 * Parser class - transforms tokens into AST
 */
export class Parser {
  private tokens: Token[] = [];
  private pos = 0;
  private pendingHeredocs: {
    redirect: RedirectionNode;
    delimiter: string;
    stripTabs: boolean;
    quoted: boolean;
  }[] = [];
  private parseIterations = 0;
  private parseDepth = 0;
  private _input = "";

  /**
   * Get the raw input string being parsed.
   * Used by conditional-parser for extracting exact whitespace in regex patterns.
   */
  getInput(): string {
    return this._input;
  }

  /**
   * Check parse iteration limit to prevent infinite loops
   */
  checkIterationLimit(): void {
    this.parseIterations++;
    if (this.parseIterations > MAX_PARSE_ITERATIONS) {
      throw new ParseException(
        "Maximum parse iterations exceeded (possible infinite loop)",
        this.current().line,
        this.current().column
      );
    }
  }

  /**
   * Increment parse depth and check limit to prevent stack overflow
   * from deeply nested constructs. Returns a function to decrement depth.
   */
  enterDepth(): () => void {
    this.parseDepth++;
    if (this.parseDepth > MAX_PARSER_DEPTH) {
      throw new ParseException(
        `Maximum parser nesting depth exceeded (${MAX_PARSER_DEPTH})`,
        this.current().line,
        this.current().column
      );
    }
    return () => {
      this.parseDepth--;
    };
  }

  /**
   * Parse a bash script string
   */
  parse(input: string, options?: LexerOptions): ScriptNode {
    // Check input size limit
    if (input.length > MAX_INPUT_SIZE) {
      throw new ParseException(
        `Input too large: ${input.length} bytes exceeds limit of ${MAX_INPUT_SIZE}`,
        1,
        1
      );
    }

    this._input = input;
    const lexer = new Lexer(input, options);
    this.tokens = lexer.tokenize();

    // Check token count limit
    if (this.tokens.length > MAX_TOKENS) {
      throw new ParseException(
        `Too many tokens: ${this.tokens.length} exceeds limit of ${MAX_TOKENS}`,
        1,
        1
      );
    }

    this.pos = 0;
    this.pendingHeredocs = [];
    this.parseIterations = 0;
    this.parseDepth = 0;
    return this.parseScript();
  }

  /**
   * Parse from pre-tokenized input
   */
  parseTokens(tokens: Token[]): ScriptNode {
    this.tokens = tokens;
    this.pos = 0;
    this.pendingHeredocs = [];
    this.parseIterations = 0;
    this.parseDepth = 0;
    return this.parseScript();
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  current(): Token {
    return this.tokens[this.pos] || this.tokens[this.tokens.length - 1];
  }

  peek(offset = 0): Token {
    return (
      this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1]
    );
  }

  advance(): Token {
    const token = this.current();
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
    return token;
  }

  getPos(): number {
    return this.pos;
  }

  /**
   * Check if current token matches any of the given types.
   * Optimized to avoid array allocation for common cases (1-4 args).
   */
  check(
    t1: TokenType,
    t2?: TokenType,
    t3?: TokenType,
    t4?: TokenType,
    ...rest: TokenType[]
  ): boolean {
    const type = this.tokens[this.pos]?.type;
    if (type === t1) return true;
    if (t2 !== undefined && type === t2) return true;
    if (t3 !== undefined && type === t3) return true;
    if (t4 !== undefined && type === t4) return true;
    if (rest.length > 0) return rest.includes(type);
    return false;
  }

  expect(type: TokenType, message?: string): Token {
    if (this.check(type)) {
      return this.advance();
    }
    const token = this.current();
    throw new ParseException(
      message || `Expected ${type}, got ${token.type}`,
      token.line,
      token.column,
      token
    );
  }

  error(message: string): never {
    const token = this.current();
    throw new ParseException(message, token.line, token.column, token);
  }

  skipNewlines(): void {
    while (this.check(TokenType.NEWLINE, TokenType.COMMENT)) {
      if (this.check(TokenType.NEWLINE)) {
        this.advance();
        // Process pending here-documents after newline
        this.processHeredocs();
      } else {
        this.advance();
      }
    }
  }

  skipSeparators(includeCaseTerminators = true): void {
    while (true) {
      if (this.check(TokenType.NEWLINE)) {
        this.advance();
        this.processHeredocs();
        continue;
      }
      if (this.check(TokenType.SEMICOLON, TokenType.COMMENT)) {
        this.advance();
        continue;
      }
      // Only skip case terminators (;;, ;&, ;;&) when explicitly allowed
      // This prevents breaking case statement parsing
      if (
        includeCaseTerminators &&
        this.check(TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND)
      ) {
        this.advance();
        continue;
      }
      break;
    }
  }

  addPendingHeredoc(
    redirect: RedirectionNode,
    delimiter: string,
    stripTabs: boolean,
    quoted: boolean
  ): void {
    this.pendingHeredocs.push({ redirect, delimiter, stripTabs, quoted });
  }

  private processHeredocs(): void {
    // Process pending here-documents
    for (const heredoc of this.pendingHeredocs) {
      if (this.check(TokenType.HEREDOC_CONTENT)) {
        const content = this.advance();
        let contentWord: WordNode;

        if (heredoc.quoted) {
          // Quoted delimiter - no expansion, store as literal
          contentWord = AST.word([AST.literal(content.value)]);
        } else {
          // Unquoted delimiter - parse for variable expansions
          // Use hereDoc=true for proper escape handling (\" is not an escape in here-docs)
          contentWord = this.parseWordFromString(
            content.value,
            false,
            false,
            false,
            true
          );
        }

        heredoc.redirect.target = AST.hereDoc(
          heredoc.delimiter,
          contentWord,
          heredoc.stripTabs,
          heredoc.quoted
        );
      }
    }
    this.pendingHeredocs = [];
  }

  isStatementEnd(): boolean {
    return this.check(
      TokenType.EOF,
      TokenType.NEWLINE,
      TokenType.SEMICOLON,
      TokenType.AMP,
      TokenType.AND_AND,
      TokenType.OR_OR,
      TokenType.RPAREN,
      TokenType.RBRACE,
      TokenType.DSEMI,
      TokenType.SEMI_AND,
      TokenType.SEMI_SEMI_AND
    );
  }

  private isCommandStart(): boolean {
    const t = this.current().type;
    return (
      t === TokenType.WORD ||
      t === TokenType.NAME ||
      t === TokenType.NUMBER ||
      t === TokenType.ASSIGNMENT_WORD ||
      t === TokenType.IF ||
      t === TokenType.FOR ||
      t === TokenType.WHILE ||
      t === TokenType.UNTIL ||
      t === TokenType.CASE ||
      t === TokenType.LPAREN ||
      t === TokenType.LBRACE ||
      t === TokenType.DPAREN_START ||
      t === TokenType.DBRACK_START ||
      t === TokenType.FUNCTION ||
      t === TokenType.BANG ||
      // 'time' is a pipeline prefix that can start a command
      t === TokenType.TIME ||
      // 'in' can appear as a command name (e.g., 'in' is not reserved outside for/case)
      t === TokenType.IN ||
      // Redirections can appear before command name (e.g., <<EOF tac)
      // POSIX allows simple_command to start with io_redirect
      t === TokenType.LESS ||
      t === TokenType.GREAT ||
      t === TokenType.DLESS ||
      t === TokenType.DGREAT ||
      t === TokenType.LESSAND ||
      t === TokenType.GREATAND ||
      t === TokenType.LESSGREAT ||
      t === TokenType.DLESSDASH ||
      t === TokenType.CLOBBER ||
      t === TokenType.TLESS ||
      t === TokenType.AND_GREAT ||
      t === TokenType.AND_DGREAT
    );
  }

  // ===========================================================================
  // SCRIPT PARSING
  // ===========================================================================

  private parseScript(): ScriptNode {
    const statements: StatementNode[] = [];
    const maxIterations = 10000;
    let iterations = 0;

    this.skipNewlines();

    while (!this.check(TokenType.EOF)) {
      iterations++;
      if (iterations > maxIterations) {
        this.error(`Parser stuck: too many iterations (>${maxIterations})`);
      }

      // Check for unexpected tokens at statement start
      // Returns a deferred error statement if the error should be deferred to execution time
      const deferredErrorStmt = this.checkUnexpectedToken();
      if (deferredErrorStmt) {
        statements.push(deferredErrorStmt);
        this.skipSeparators(false);
        continue;
      }

      const posBefore = this.pos;
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      }
      // Don't skip case terminators (;;, ;&, ;;&) at script level - they're syntax errors
      this.skipSeparators(false);

      // Check for case terminators at script level - these are syntax errors
      if (
        this.check(TokenType.DSEMI, TokenType.SEMI_AND, TokenType.SEMI_SEMI_AND)
      ) {
        this.error(
          `syntax error near unexpected token \`${this.current().value}'`
        );
      }

      // Safety: if we didn't advance, force advance to prevent infinite loop
      if (this.pos === posBefore && !this.check(TokenType.EOF)) {
        this.advance();
      }
    }

    return AST.script(statements);
  }

  /**
   * Check for unexpected tokens that can't appear at statement start.
   * Returns a deferred error statement for tokens that should cause errors
   * at execution time rather than parse time (to match bash's incremental behavior).
   */
  private checkUnexpectedToken(): StatementNode | null {
    const t = this.current().type;
    const v = this.current().value;

    // Check for unexpected reserved words that can only appear inside specific constructs
    if (
      t === TokenType.DO ||
      t === TokenType.DONE ||
      t === TokenType.THEN ||
      t === TokenType.ELSE ||
      t === TokenType.ELIF ||
      t === TokenType.FI ||
      t === TokenType.ESAC
    ) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }

    // Check for unexpected closing braces/parens
    // These create deferred errors that trigger at execution time, to match
    // bash's incremental parsing behavior. Example:
    //   set -o errexit
    //   {ls;     # This is a command "{ls" that fails (not brace group)
    //   }        # This would be a syntax error, but errexit exits first
    if (t === TokenType.RBRACE || t === TokenType.RPAREN) {
      const errorMsg = `syntax error near unexpected token \`${v}'`;
      this.advance(); // Consume the token
      // Create an empty statement with a deferred error
      return AST.statement(
        [AST.pipeline([AST.simpleCommand(null, [], [], [])])],
        [],
        false,
        { message: errorMsg, token: v }
      );
    }

    // Check for case terminators at statement start
    if (
      t === TokenType.DSEMI ||
      t === TokenType.SEMI_AND ||
      t === TokenType.SEMI_SEMI_AND
    ) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }

    // Check for bare semicolon (with nothing before it)
    if (t === TokenType.SEMICOLON) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }

    // Check for pipe at statement start (e.g., newline followed by |)
    // This is a syntax error: "| cmd" with nothing before it
    if (t === TokenType.PIPE || t === TokenType.PIPE_AMP) {
      this.error(`syntax error near unexpected token \`${v}'`);
    }

    return null;
  }

  // ===========================================================================
  // STATEMENT PARSING
  // ===========================================================================

  parseStatement(): StatementNode | null {
    this.skipNewlines();

    if (!this.isCommandStart()) {
      return null;
    }

    // Record the start position for verbose mode source text
    const startOffset = this.current().start;

    const pipelines: PipelineNode[] = [];
    const operators: ("&&" | "||" | ";")[] = [];
    let background = false;

    // Parse first pipeline
    const firstPipeline = this.parsePipeline();
    pipelines.push(firstPipeline);

    // Parse additional pipelines connected by && or ||
    while (this.check(TokenType.AND_AND, TokenType.OR_OR)) {
      const op = this.advance();
      operators.push(op.type === TokenType.AND_AND ? "&&" : "||");
      this.skipNewlines();
      const nextPipeline = this.parsePipeline();
      pipelines.push(nextPipeline);
    }

    // Check for background execution
    if (this.check(TokenType.AMP)) {
      this.advance();
      background = true;
    }

    // Extract source text for verbose mode (set -v)
    // Get the end position from the last consumed token
    const endOffset =
      this.pos > 0 ? this.tokens[this.pos - 1].end : startOffset;
    const sourceText = this._input.slice(startOffset, endOffset);

    return AST.statement(
      pipelines,
      operators,
      background,
      undefined,
      sourceText
    );
  }

  // ===========================================================================
  // PIPELINE PARSING
  // ===========================================================================

  private parsePipeline(): PipelineNode {
    // Check for 'time' keyword at the beginning of pipeline
    // time [-p] pipeline
    let timed = false;
    let timePosix = false;
    if (this.check(TokenType.TIME)) {
      this.advance();
      timed = true;
      // Check for -p option (POSIX format)
      if (
        this.check(TokenType.WORD, TokenType.NAME) &&
        this.current().value === "-p"
      ) {
        this.advance();
        timePosix = true;
      }
    }

    let negationCount = 0;

    // Check for ! (negation) - multiple ! tokens can appear
    // e.g., "! ! true" means double negation (cancels out)
    while (this.check(TokenType.BANG)) {
      this.advance();
      negationCount++;
    }
    const negated = negationCount % 2 === 1;

    const commands: CommandNode[] = [];
    const pipeStderr: boolean[] = [];

    // Parse first command
    const firstCmd = this.parseCommand();
    commands.push(firstCmd);

    // Parse additional commands in pipeline
    while (this.check(TokenType.PIPE, TokenType.PIPE_AMP)) {
      const pipeToken = this.advance();
      this.skipNewlines();

      // Track whether this pipe is |& (pipes stderr too)
      pipeStderr.push(pipeToken.type === TokenType.PIPE_AMP);

      const nextCmd = this.parseCommand();
      commands.push(nextCmd);
    }

    return AST.pipeline(
      commands,
      negated,
      timed,
      timePosix,
      pipeStderr.length > 0 ? pipeStderr : undefined
    );
  }

  // ===========================================================================
  // COMMAND PARSING
  // ===========================================================================

  private parseCommand(): CommandNode {
    // Check for compound commands
    if (this.check(TokenType.IF)) {
      return CompoundParser.parseIf(this);
    }
    if (this.check(TokenType.FOR)) {
      return CompoundParser.parseFor(this);
    }
    if (this.check(TokenType.WHILE)) {
      return CompoundParser.parseWhile(this);
    }
    if (this.check(TokenType.UNTIL)) {
      return CompoundParser.parseUntil(this);
    }
    if (this.check(TokenType.CASE)) {
      return CompoundParser.parseCase(this);
    }
    if (this.check(TokenType.LPAREN)) {
      return CompoundParser.parseSubshell(this);
    }
    if (this.check(TokenType.LBRACE)) {
      return CompoundParser.parseGroup(this);
    }
    if (this.check(TokenType.DPAREN_START)) {
      // Check if this (( )) closes with ) ) (nested subshells) or )) (arithmetic)
      // Scan ahead to find the matching close
      if (this.dparenClosesWithSpacedParens()) {
        // The (( will close with ) ) - treat as nested subshells ( ( ... ) )
        return this.parseNestedSubshellsFromDparen();
      }
      return this.parseArithmeticCommand();
    }
    if (this.check(TokenType.DBRACK_START)) {
      return this.parseConditionalCommand();
    }
    if (this.check(TokenType.FUNCTION)) {
      return this.parseFunctionDef();
    }

    // Check for function definition: name () { ... }
    if (
      this.check(TokenType.NAME, TokenType.WORD) &&
      this.peek(1).type === TokenType.LPAREN &&
      this.peek(2).type === TokenType.RPAREN
    ) {
      return this.parseFunctionDef();
    }

    // Simple command
    return CmdParser.parseSimpleCommand(this);
  }

  /**
   * Scan ahead from current DPAREN_START to determine if it closes with ) )
   * (two separate RPAREN tokens) or )) (DPAREN_END token).
   * Returns true if it closes with ) ) (nested subshells case).
   */
  private dparenClosesWithSpacedParens(): boolean {
    // Scan through tokens tracking paren depth
    let depth = 1; // We've seen one (( - need to track nested parens
    let offset = 1; // Start after the DPAREN_START

    while (offset < this.tokens.length - this.pos) {
      const tok = this.peek(offset);
      if (tok.type === TokenType.EOF) {
        return false;
      }

      if (
        tok.type === TokenType.DPAREN_START ||
        tok.type === TokenType.LPAREN
      ) {
        depth++;
      } else if (tok.type === TokenType.DPAREN_END) {
        depth -= 2; // )) closes two levels
        if (depth <= 0) {
          // Closes with )) - this is arithmetic
          return false;
        }
      } else if (tok.type === TokenType.RPAREN) {
        depth--;
        if (depth === 0) {
          // Check if next token is also RPAREN
          const nextTok = this.peek(offset + 1);
          if (nextTok.type === TokenType.RPAREN) {
            // Closes with ) ) - this is nested subshells
            return true;
          }
        }
      }
      offset++;
    }

    return false;
  }

  /**
   * Parse (( ... ) ) as nested subshells when we know it closes with ) ).
   * We've already determined via dparenClosesWithSpacedParens() that this
   * DPAREN_START should be treated as two LPAREN tokens.
   */
  private parseNestedSubshellsFromDparen(): SubshellNode {
    // Skip the DPAREN_START token (which we're treating as two LPARENs)
    this.advance();

    // Parse the inner subshell body
    // This is like being inside ( ( ... ) ) where we've consumed both (
    const innerBody = this.parseCompoundList();

    // Expect the first )
    this.expect(TokenType.RPAREN);

    // Now we're back at the outer subshell level
    // The inner subshell is our body

    // Expect the second ) (which closes the outer subshell we're implicitly in)
    this.expect(TokenType.RPAREN);

    const redirections = this.parseOptionalRedirections();

    // Wrap the inner body in a subshell node
    // The structure is: Subshell(body: [Subshell(body: innerBody)])
    const innerSubshell = AST.subshell(innerBody, []);

    return AST.subshell(
      [AST.statement([AST.pipeline([innerSubshell], false, false, false)])],
      redirections
    );
  }

  // ===========================================================================
  // WORD PARSING
  // ===========================================================================

  isWord(): boolean {
    const t = this.current().type;
    return (
      t === TokenType.WORD ||
      t === TokenType.NAME ||
      t === TokenType.NUMBER ||
      // Reserved words can be used as words in certain contexts (e.g., "echo if")
      t === TokenType.IF ||
      t === TokenType.FOR ||
      t === TokenType.WHILE ||
      t === TokenType.UNTIL ||
      t === TokenType.CASE ||
      t === TokenType.FUNCTION ||
      t === TokenType.ELSE ||
      t === TokenType.ELIF ||
      t === TokenType.FI ||
      t === TokenType.THEN ||
      t === TokenType.DO ||
      t === TokenType.DONE ||
      t === TokenType.ESAC ||
      t === TokenType.IN ||
      t === TokenType.SELECT ||
      t === TokenType.TIME ||
      t === TokenType.COPROC ||
      // Operators that can appear as words in command arguments (e.g., "[ ! -z foo ]")
      t === TokenType.BANG
    );
  }

  parseWord(): WordNode {
    const token = this.advance();
    return this.parseWordFromString(
      token.value,
      token.quoted,
      token.singleQuoted
    );
  }

  /**
   * Parse a word without brace expansion (for [[ ]] conditionals).
   * In bash, brace expansion does not occur inside [[ ]].
   */
  parseWordNoBraceExpansion(): WordNode {
    const token = this.advance();
    return this.parseWordFromString(
      token.value,
      token.quoted,
      token.singleQuoted,
      false, // isAssignment
      false, // hereDoc
      true // noBraceExpansion
    );
  }

  /**
   * Parse a word for regex patterns (in [[ =~ ]]).
   * All escaped characters create Escaped nodes so the backslash is preserved
   * for the regex engine. For example, \$ creates Escaped("$") which becomes \$
   * in the final regex pattern.
   */
  parseWordForRegex(): WordNode {
    const token = this.advance();
    return this.parseWordFromString(
      token.value,
      token.quoted,
      token.singleQuoted,
      false, // isAssignment
      false, // hereDoc
      true, // noBraceExpansion
      true // regexPattern
    );
  }

  parseWordFromString(
    value: string,
    quoted = false,
    singleQuoted = false,
    isAssignment = false,
    hereDoc = false,
    noBraceExpansion = false,
    regexPattern = false
  ): WordNode {
    const parts = ExpParser.parseWordParts(
      this,
      value,
      quoted,
      singleQuoted,
      isAssignment,
      hereDoc,
      false, // singleQuotesAreLiteral
      noBraceExpansion,
      regexPattern
    );
    return AST.word(parts);
  }

  parseCommandSubstitution(
    value: string,
    start: number
  ): { part: CommandSubstitutionPart; endIndex: number } {
    return parseCommandSubstitutionFromString(
      value,
      start,
      () => new Parser(),
      (msg) => this.error(msg)
    );
  }

  parseBacktickSubstitution(
    value: string,
    start: number,
    /** Whether the backtick is inside double quotes */
    inDoubleQuotes = false
  ): { part: CommandSubstitutionPart; endIndex: number } {
    return parseBacktickSubstitutionFromString(
      value,
      start,
      inDoubleQuotes,
      () => new Parser(),
      (msg) => this.error(msg)
    );
  }

  /**
   * Check if $(( at position `start` in `value` is a command substitution with nested
   * subshell rather than arithmetic expansion.
   */
  isDollarDparenSubshell(value: string, start: number): boolean {
    return isDollarDparenSubshellHelper(value, start);
  }

  parseArithmeticExpansion(
    value: string,
    start: number
  ): { part: ArithmeticExpansionPart; endIndex: number } {
    // Skip $((
    const exprStart = start + 3;
    let arithDepth = 1; // Tracks (( and ))
    let parenDepth = 0; // Tracks single ( and ) for command subs, groups
    let i = exprStart;

    while (i < value.length - 1 && arithDepth > 0) {
      // Check for $( command substitution
      if (value[i] === "$" && value[i + 1] === "(") {
        if (value[i + 2] === "(") {
          // Nested arithmetic $((
          arithDepth++;
          i += 3;
        } else {
          // Command substitution $(
          parenDepth++;
          i += 2;
        }
      } else if (value[i] === "(" && value[i + 1] === "(") {
        // Nested arithmetic ((
        arithDepth++;
        i += 2;
      } else if (value[i] === ")" && value[i + 1] === ")") {
        // Could be closing arithmetic )) or closing ) followed by something
        if (parenDepth > 0) {
          // The first ) closes a command sub
          parenDepth--;
          i++;
        } else {
          // Closing arithmetic ))
          arithDepth--;
          if (arithDepth > 0) i += 2;
        }
      } else if (value[i] === "(") {
        // Opening paren (group, subshell, etc.)
        parenDepth++;
        i++;
      } else if (value[i] === ")") {
        // Closing paren
        if (parenDepth > 0) {
          parenDepth--;
        }
        i++;
      } else {
        i++;
      }
    }

    const exprStr = value.slice(exprStart, i);
    const expression = this.parseArithmeticExpression(exprStr);

    return {
      part: AST.arithmeticExpansion(expression),
      endIndex: i + 2
    };
  }

  private parseArithmeticCommand(): ArithmeticCommandNode {
    const startToken = this.expect(TokenType.DPAREN_START);

    // Read expression until )) at paren depth 0
    // We need to track single paren depth to handle cases like ((a=1 + (2*3)))
    // where ))) should be parsed as ) + )) not )) + )
    let exprStr = "";
    let dparenDepth = 1;
    let parenDepth = 0;
    let pendingRparen = false; // Track if we have a "virtual" ) from splitting ))

    let foundClosing = false;
    while (dparenDepth > 0 && !this.check(TokenType.EOF)) {
      // First check if we have a pending ) from a previous )) split
      if (pendingRparen) {
        pendingRparen = false;
        if (parenDepth > 0) {
          parenDepth--;
          exprStr += ")";
          continue;
        }
        // parenDepth is 0, so this pending ) plus next ) closes the outer ((
        // Check if next token is also ) or ))
        if (this.check(TokenType.RPAREN)) {
          dparenDepth--;
          foundClosing = true;
          this.advance();
          continue;
        }
        if (this.check(TokenType.DPAREN_END)) {
          // The )) here is unexpected since we just had a pending ) - treat it as closing
          dparenDepth--;
          foundClosing = true;
          // Don't advance - the )) might be needed for another purpose
          continue;
        }
        // Otherwise just add the ) to exprStr (shouldn't happen in well-formed input)
        exprStr += ")";
        continue;
      }

      if (this.check(TokenType.DPAREN_START)) {
        dparenDepth++;
        exprStr += "((";
        this.advance();
      } else if (this.check(TokenType.DPAREN_END)) {
        // If we have unmatched single parens, the )) should close them first
        if (parenDepth >= 2) {
          // Need both ) from )) to close inner parens
          parenDepth -= 2;
          exprStr += "))";
          this.advance();
        } else if (parenDepth === 1) {
          // First ) closes inner paren, second ) creates pending
          parenDepth--;
          exprStr += ")";
          pendingRparen = true;
          this.advance();
        } else {
          // parenDepth is 0, this )) closes the outer arithmetic
          dparenDepth--;
          foundClosing = true;
          if (dparenDepth > 0) {
            exprStr += "))";
          }
          this.advance();
        }
      } else if (this.check(TokenType.LPAREN)) {
        parenDepth++;
        exprStr += "(";
        this.advance();
      } else if (this.check(TokenType.RPAREN)) {
        if (parenDepth > 0) {
          parenDepth--;
        }
        exprStr += ")";
        this.advance();
      } else {
        const value = this.current().value;
        // Add space between tokens, but not before operators that can form compounds
        // (like | followed by = to form |=) or after operators that form compounds
        const lastChar = exprStr.length > 0 ? exprStr[exprStr.length - 1] : "";
        const needsSpace =
          exprStr.length > 0 &&
          !exprStr.endsWith(" ") &&
          // Don't add space before = after operators that can form compound assignments
          !(value === "=" && /[|&^+\-*/%<>]$/.test(exprStr)) &&
          // Don't add space before second < or > (for << or >>)
          !(value === "<" && lastChar === "<") &&
          !(value === ">" && lastChar === ">");
        if (needsSpace) {
          exprStr += " ";
        }
        exprStr += value;
        this.advance();
      }
    }

    // Only expect DPAREN_END if we didn't already consume the closing via splitting
    if (!foundClosing) {
      this.expect(TokenType.DPAREN_END);
    }

    const expression = this.parseArithmeticExpression(exprStr.trim());
    const redirections = this.parseOptionalRedirections();

    return AST.arithmeticCommand(expression, redirections, startToken.line);
  }

  private parseConditionalCommand(): ConditionalCommandNode {
    const startToken = this.expect(TokenType.DBRACK_START);

    const expression = CondParser.parseConditionalExpression(this);

    this.expect(TokenType.DBRACK_END);

    const redirections = this.parseOptionalRedirections();

    return AST.conditionalCommand(expression, redirections, startToken.line);
  }

  private parseFunctionDef(): FunctionDefNode {
    let name: string;

    // function name { ... } or function name () { ... }
    if (this.check(TokenType.FUNCTION)) {
      this.advance();
      // Function names are more permissive than variable names - they can contain
      // hyphens, dots, colons, slashes, etc. Accept both NAME and WORD tokens.
      if (this.check(TokenType.NAME) || this.check(TokenType.WORD)) {
        name = this.advance().value;
      } else {
        const token = this.current();
        throw new ParseException(
          "Expected function name",
          token.line,
          token.column,
          token
        );
      }

      // Optional ()
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        this.expect(TokenType.RPAREN);
      }
    } else {
      // name () { ... }
      name = this.advance().value;
      // Validate that the name doesn't contain expansion characters
      // bash rejects: $foo() { ... } and foo-$(echo hi)() { ... }
      if (name.includes("$")) {
        this.error(`\`${name}': not a valid identifier`);
      }
      this.expect(TokenType.LPAREN);
      this.expect(TokenType.RPAREN);
    }

    this.skipNewlines();

    // Parse body (must be compound command)
    // For function bodies, redirections are NOT parsed on the body - they go on the function def
    const body = this.parseCompoundCommandBody({ forFunctionBody: true });

    const redirections = this.parseOptionalRedirections();

    return AST.functionDef(name, body, redirections);
  }

  private parseCompoundCommandBody(options?: {
    forFunctionBody?: boolean;
  }): CompoundCommandNode {
    const skipRedirections = options?.forFunctionBody;
    if (this.check(TokenType.LBRACE)) {
      return CompoundParser.parseGroup(this, { skipRedirections });
    }
    if (this.check(TokenType.LPAREN)) {
      return CompoundParser.parseSubshell(this, { skipRedirections });
    }
    if (this.check(TokenType.IF)) {
      return CompoundParser.parseIf(this, { skipRedirections });
    }
    if (this.check(TokenType.FOR)) {
      return CompoundParser.parseFor(this, { skipRedirections });
    }
    if (this.check(TokenType.WHILE)) {
      return CompoundParser.parseWhile(this, { skipRedirections });
    }
    if (this.check(TokenType.UNTIL)) {
      return CompoundParser.parseUntil(this, { skipRedirections });
    }
    if (this.check(TokenType.CASE)) {
      return CompoundParser.parseCase(this, { skipRedirections });
    }

    this.error("Expected compound command for function body");
  }

  // ===========================================================================
  // HELPER PARSING
  // ===========================================================================

  parseCompoundList(): StatementNode[] {
    const exitDepth = this.enterDepth();
    const statements: StatementNode[] = [];

    this.skipNewlines();

    while (
      !this.check(
        TokenType.EOF,
        TokenType.FI,
        TokenType.ELSE,
        TokenType.ELIF,
        TokenType.THEN,
        TokenType.DO,
        TokenType.DONE,
        TokenType.ESAC,
        TokenType.RPAREN,
        TokenType.RBRACE,
        TokenType.DSEMI,
        TokenType.SEMI_AND,
        TokenType.SEMI_SEMI_AND
      ) &&
      this.isCommandStart()
    ) {
      this.checkIterationLimit();
      const posBefore = this.pos;

      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      }
      this.skipSeparators();

      // Safety: if we didn't advance and didn't get a statement, break
      if (this.pos === posBefore && !stmt) {
        break;
      }
    }

    exitDepth();
    return statements;
  }

  parseOptionalRedirections(): RedirectionNode[] {
    const redirections: RedirectionNode[] = [];

    while (CmdParser.isRedirection(this)) {
      this.checkIterationLimit();
      const posBefore = this.pos;

      redirections.push(CmdParser.parseRedirection(this));

      // Safety: if we didn't advance, break
      if (this.pos === posBefore) {
        break;
      }
    }

    return redirections;
  }

  // ===========================================================================
  // ARITHMETIC EXPRESSION PARSING
  // ===========================================================================

  parseArithmeticExpression(input: string): ArithmeticExpressionNode {
    return ArithParser.parseArithmeticExpression(this, input);
  }
}

/**
 * Convenience function to parse a bash script
 */
export function parse(input: string, options?: LexerOptions): ScriptNode {
  const parser = new Parser();
  return parser.parse(input, options);
}
