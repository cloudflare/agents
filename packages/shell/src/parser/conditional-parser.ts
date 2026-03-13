/**
 * Conditional Expression Parser
 *
 * Handles parsing of [[ ... ]] conditional commands.
 */

import type {
  CondBinaryOperator,
  ConditionalExpressionNode,
  CondUnaryOperator,
  WordNode,
  WordPart
} from "../ast/types";
import { TokenType } from "./lexer";
import type { Parser } from "./parser";

// Unary operators for conditional expressions
const UNARY_OPS = [
  "-a",
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-g",
  "-h",
  "-k",
  "-p",
  "-r",
  "-s",
  "-t",
  "-u",
  "-w",
  "-x",
  "-G",
  "-L",
  "-N",
  "-O",
  "-S",
  "-z",
  "-n",
  "-o",
  "-v",
  "-R"
];

// Binary operators for conditional expressions
const BINARY_OPS = [
  "==",
  "!=",
  "=~",
  "<",
  ">",
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef"
];

/**
 * Check if the current token is a valid conditional operand.
 * In [[ ]], { and } can be used as plain string operands.
 * Also, ASSIGNMENT_WORD tokens (like a=x) are treated as plain words in [[ ]].
 */
function isCondOperand(p: Parser): boolean {
  return (
    p.isWord() ||
    p.check(TokenType.LBRACE) ||
    p.check(TokenType.RBRACE) ||
    p.check(TokenType.ASSIGNMENT_WORD)
  );
}

/**
 * Parse a pattern word for the RHS of == or != in [[ ]].
 * Handles the special case of !(...) extglob patterns where the lexer
 * tokenizes `!` as BANG and `(` as LPAREN separately.
 */
function parsePatternWord(p: Parser): WordNode {
  // Check for !(...) extglob pattern: BANG followed by LPAREN
  if (p.check(TokenType.BANG) && p.peek(1).type === TokenType.LPAREN) {
    // Consume the BANG token
    p.advance();
    // Consume the LPAREN token
    p.advance();

    // Now we need to find the matching ) and collect everything as an extglob pattern
    // Track parenthesis depth
    let depth = 1;
    let pattern = "!(";

    while (depth > 0 && !p.check(TokenType.EOF)) {
      if (p.check(TokenType.LPAREN)) {
        depth++;
        pattern += "(";
        p.advance();
      } else if (p.check(TokenType.RPAREN)) {
        depth--;
        if (depth > 0) {
          pattern += ")";
        }
        p.advance();
      } else if (p.isWord()) {
        pattern += p.advance().value;
      } else if (p.check(TokenType.PIPE)) {
        pattern += "|";
        p.advance();
      } else {
        // Unexpected token
        break;
      }
    }

    pattern += ")";

    // Parse the pattern string to create proper word parts
    return p.parseWordFromString(pattern, false, false, false, false, true);
  }

  // Normal case - just parse a word
  return p.parseWordNoBraceExpansion();
}

export function parseConditionalExpression(
  p: Parser
): ConditionalExpressionNode {
  // Skip leading newlines inside [[ ]]
  p.skipNewlines();
  return parseCondOr(p);
}

function parseCondOr(p: Parser): ConditionalExpressionNode {
  let left = parseCondAnd(p);

  // Skip newlines before ||
  p.skipNewlines();
  while (p.check(TokenType.OR_OR)) {
    p.advance();
    // Skip newlines after ||
    p.skipNewlines();
    const right = parseCondAnd(p);
    left = { type: "CondOr", left, right };
    p.skipNewlines();
  }

  return left;
}

function parseCondAnd(p: Parser): ConditionalExpressionNode {
  let left = parseCondNot(p);

  // Skip newlines before &&
  p.skipNewlines();
  while (p.check(TokenType.AND_AND)) {
    p.advance();
    // Skip newlines after &&
    p.skipNewlines();
    const right = parseCondNot(p);
    left = { type: "CondAnd", left, right };
    p.skipNewlines();
  }

  return left;
}

function parseCondNot(p: Parser): ConditionalExpressionNode {
  p.skipNewlines();
  if (p.check(TokenType.BANG)) {
    p.advance();
    p.skipNewlines();
    const operand = parseCondNot(p);
    return { type: "CondNot", operand };
  }

  return parseCondPrimary(p);
}

function parseCondPrimary(p: Parser): ConditionalExpressionNode {
  // Handle grouping: ( expr )
  if (p.check(TokenType.LPAREN)) {
    p.advance();
    const expression = parseConditionalExpression(p);
    p.expect(TokenType.RPAREN);
    return { type: "CondGroup", expression };
  }

  // Handle unary operators: -f file, -z string, etc.
  // In [[ ]], { and } can be used as plain string operands
  if (isCondOperand(p)) {
    const firstToken = p.current();
    const first = firstToken.value;

    // Check for unary operators - only if NOT quoted
    // Quoted '-f' etc. are string operands, not test operators
    if (UNARY_OPS.includes(first) && !firstToken.quoted) {
      p.advance();
      // Unary operators require an operand - syntax error if at end
      if (p.check(TokenType.DBRACK_END)) {
        p.error(`Expected operand after ${first}`);
      }
      if (isCondOperand(p)) {
        const operand = p.parseWordNoBraceExpansion();
        return {
          type: "CondUnary",
          operator: first as CondUnaryOperator,
          operand
        };
      }
      // Unary operator followed by non-word token (like < > && ||) is a syntax error
      // bash: "unexpected argument `<' to conditional unary operator"
      const badToken = p.current();
      p.error(
        `unexpected argument \`${badToken.value}' to conditional unary operator`
      );
    }

    // Parse as word, then check for binary operator
    const left = p.parseWordNoBraceExpansion();

    // Check for binary operators
    if (p.isWord() && BINARY_OPS.includes(p.current().value)) {
      const operator = p.advance().value;
      // For =~ operator, the RHS can include unquoted ( and ) for regex grouping
      // Parse until we hit ]], &&, ||, or newline
      // For == and != operators, the RHS is a pattern (may include !(...) extglob)
      let right: WordNode;
      if (operator === "=~") {
        right = parseRegexPattern(p);
      } else if (operator === "==" || operator === "!=") {
        right = parsePatternWord(p);
      } else {
        right = p.parseWordNoBraceExpansion();
      }
      return {
        type: "CondBinary",
        operator: operator as CondBinaryOperator,
        left,
        right
      };
    }

    // Check for < and > which are tokenized as LESS and GREAT
    if (p.check(TokenType.LESS)) {
      p.advance();
      const right = p.parseWordNoBraceExpansion();
      return {
        type: "CondBinary",
        operator: "<",
        left,
        right
      };
    }
    if (p.check(TokenType.GREAT)) {
      p.advance();
      const right = p.parseWordNoBraceExpansion();
      return {
        type: "CondBinary",
        operator: ">",
        left,
        right
      };
    }

    // Check for = (assignment/equality in test)
    if (p.isWord() && p.current().value === "=") {
      p.advance();
      const right = parsePatternWord(p);
      return {
        type: "CondBinary",
        operator: "==",
        left,
        right
      };
    }

    // Just a word (non-empty string test)
    return { type: "CondWord", word: left };
  }

  p.error("Expected conditional expression");
}

/**
 * Parse a regex pattern for the =~ operator.
 * In bash, the RHS of =~ can include unquoted ( and ) for regex grouping.
 * We collect tokens until we hit ]], &&, ||, or newline.
 *
 * Important rules:
 * - Track parenthesis depth to distinguish between regex grouping and conditional grouping
 * - At the top level (parenDepth === 0), tokens must be adjacent (no spaces)
 * - Inside parentheses (parenDepth > 0), spaces are allowed and operators lose special meaning
 * - This matches bash behavior: "[[ a =~ c a ]]" is a syntax error,
 *   but "[[ a =~ (c a) ]]" is valid
 */
function parseRegexPattern(p: Parser): WordNode {
  const parts: WordPart[] = [];
  let parenDepth = 0; // Track nested parens in the regex pattern
  let lastTokenEnd = -1; // Track end position of last consumed token
  const input = p.getInput(); // Get raw input for extracting exact whitespace

  // Helper to check if we're at a pattern terminator
  const isTerminator = () =>
    p.check(TokenType.DBRACK_END) ||
    p.check(TokenType.AND_AND) ||
    p.check(TokenType.OR_OR) ||
    p.check(TokenType.NEWLINE) ||
    p.check(TokenType.EOF);

  while (!isTerminator()) {
    const currentToken = p.current();
    const hasGap = lastTokenEnd >= 0 && currentToken.start > lastTokenEnd;

    // At top level (outside parens), tokens must be adjacent (no space gap)
    // Inside parens, spaces are allowed (regex groups can contain spaces)
    if (parenDepth === 0 && hasGap) {
      // There's a gap (whitespace) between the last token and this one
      // Stop parsing - remaining tokens will cause a syntax error
      break;
    }

    // Inside parens, preserve the exact whitespace from the input
    if (parenDepth > 0 && hasGap) {
      // Extract the exact whitespace characters from the raw input
      const whitespace = input.slice(lastTokenEnd, currentToken.start);
      parts.push({ type: "Literal", value: whitespace });
    }

    if (p.isWord() || p.check(TokenType.ASSIGNMENT_WORD)) {
      // Parse word parts for regex (this preserves backslash escapes as Escaped nodes)
      // ASSIGNMENT_WORD tokens (like a=) are treated as plain words in regex patterns
      const word = p.parseWordForRegex();
      parts.push(...word.parts);
      // After parseWord, position has advanced - get the consumed token's end
      lastTokenEnd = p.peek(-1).end;
    } else if (p.check(TokenType.LPAREN)) {
      // Unquoted ( in regex pattern - part of regex grouping
      const token = p.advance();
      parts.push({ type: "Literal", value: "(" });
      parenDepth++;
      lastTokenEnd = token.end;
    } else if (p.check(TokenType.DPAREN_START)) {
      // (( is tokenized as DPAREN_START, but inside regex it's two ( chars
      const token = p.advance();
      parts.push({ type: "Literal", value: "((" });
      parenDepth += 2;
      lastTokenEnd = token.end;
    } else if (p.check(TokenType.DPAREN_END)) {
      // )) is tokenized as DPAREN_END, but inside regex it's two ) chars
      if (parenDepth >= 2) {
        const token = p.advance();
        parts.push({ type: "Literal", value: "))" });
        parenDepth -= 2;
        lastTokenEnd = token.end;
      } else if (parenDepth === 1) {
        // Only one ( is open, this )) closes it and the extra ) is conditional grouping
        // Don't consume, let the RPAREN handler deal with it
        break;
      } else {
        // No open regex parens - this )) is part of the conditional expression
        break;
      }
    } else if (p.check(TokenType.RPAREN)) {
      // Unquoted ) - could be regex grouping or conditional expression grouping
      if (parenDepth > 0) {
        // We have an open paren from the regex, this ) closes it
        const token = p.advance();
        parts.push({ type: "Literal", value: ")" });
        parenDepth--;
        lastTokenEnd = token.end;
      } else {
        // No open regex parens - this ) is part of the conditional expression
        // Stop parsing the regex pattern here
        break;
      }
    } else if (p.check(TokenType.PIPE)) {
      // Unquoted | in regex pattern - regex alternation (foo|bar)
      const token = p.advance();
      parts.push({ type: "Literal", value: "|" });
      lastTokenEnd = token.end;
    } else if (p.check(TokenType.SEMICOLON)) {
      // Unquoted ; in regex pattern - only valid inside parentheses
      if (parenDepth > 0) {
        const token = p.advance();
        parts.push({ type: "Literal", value: ";" });
        lastTokenEnd = token.end;
      } else {
        // At top level, semicolon is a command terminator, stop parsing
        break;
      }
    } else if (parenDepth > 0 && p.check(TokenType.LESS)) {
      // Unquoted < inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "<" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.GREAT)) {
      // Unquoted > inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: ">" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.DGREAT)) {
      // Unquoted >> inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: ">>" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.DLESS)) {
      // Unquoted << inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "<<" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.LESSAND)) {
      // Unquoted <& inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "<&" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.GREATAND)) {
      // Unquoted >& inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: ">&" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.LESSGREAT)) {
      // Unquoted <> inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "<>" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.CLOBBER)) {
      // Unquoted >| inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: ">|" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.TLESS)) {
      // Unquoted <<< inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "<<<" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.AMP)) {
      // Unquoted & inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "&" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.LBRACE)) {
      // Unquoted { inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "{" });
      lastTokenEnd = token.end;
    } else if (parenDepth > 0 && p.check(TokenType.RBRACE)) {
      // Unquoted } inside parentheses - treated as literal in regex
      const token = p.advance();
      parts.push({ type: "Literal", value: "}" });
      lastTokenEnd = token.end;
    } else {
      // Unknown token, stop parsing
      break;
    }
  }

  if (parts.length === 0) {
    p.error("Expected regex pattern after =~");
  }

  return { type: "Word", parts };
}
