/**
 * Expansion Parser
 *
 * Handles parsing of parameter expansions, arithmetic expansions, etc.
 */

import {
  AST,
  type InnerParameterOperation,
  type ParameterExpansionPart,
  type ParameterOperation,
  type WordNode,
  type WordPart
} from "../ast/types";
import { parseArithmeticExpression } from "./arithmetic-parser";
import type { Parser } from "./parser";
import { ParseException } from "./types";
import * as WordParser from "./word-parser";

/** Ensure a word-parts array is non-empty (use empty-string literal as fallback). */
function ensureNonEmpty(parts: WordPart[]): WordPart[] {
  return parts.length > 0 ? parts : [AST.literal("")];
}

/**
 * Find the closing parenthesis for an extglob pattern starting at openIdx.
 * Handles nested extglob patterns and escaped characters.
 */
function findExtglobClose(value: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < value.length && depth > 0) {
    const c = value[i];
    if (c === "\\") {
      i += 2; // Skip escaped char
      continue;
    }
    // Handle nested extglob patterns
    if ("@*+?!".includes(c) && i + 1 < value.length && value[i + 1] === "(") {
      i++; // Skip the extglob operator
      depth++;
      i++; // Skip the (
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

function parseSimpleParameter(
  _p: Parser,
  value: string,
  start: number
): { part: ParameterExpansionPart; endIndex: number } {
  let i = start + 1;
  const char = value[i];

  // Special parameters: $@, $*, $#, $?, $$, $!, $-, $0-$9
  if ("@*#?$!-0123456789".includes(char)) {
    return {
      part: AST.parameterExpansion(char),
      endIndex: i + 1
    };
  }

  // Variable name
  let name = "";
  while (i < value.length && /[a-zA-Z0-9_]/.test(value[i])) {
    name += value[i];
    i++;
  }

  return {
    part: AST.parameterExpansion(name),
    endIndex: i
  };
}

function parseParameterExpansion(
  p: Parser,
  value: string,
  start: number,
  quoted = false
): { part: ParameterExpansionPart; endIndex: number } {
  // Skip ${
  let i = start + 2;

  // Handle ${!var} indirection
  let indirection = false;
  if (value[i] === "!") {
    indirection = true;
    i++;
  }

  // Handle ${#var} length
  let lengthOp = false;
  if (value[i] === "#" && !/[}:#%/^,]/.test(value[i + 1] || "}")) {
    lengthOp = true;
    i++;
  }

  // Parse parameter name
  // For special single-char vars ($@, $*, $#, $?, $$, $!, $-), just take one char
  // For regular vars, stop at operators (#, %, /, :, etc.)
  let name = "";
  const firstChar = value[i];
  if (/[@*#?$!-]/.test(firstChar) && !/[a-zA-Z0-9_]/.test(value[i + 1] || "")) {
    // Single special character variable
    name = firstChar;
    i++;
  } else {
    // Regular variable name (alphanumeric + underscore only)
    while (i < value.length && /[a-zA-Z0-9_]/.test(value[i])) {
      name += value[i];
      i++;
    }
  }

  // Handle array subscript
  if (value[i] === "[") {
    const closeIdx = WordParser.findMatchingBracket(p, value, i, "[", "]");
    name += value.slice(i, closeIdx + 1);
    i = closeIdx + 1;

    // Check for multiple subscripts like ${a[0][0]} - this is invalid syntax
    if (value[i] === "[") {
      // Find closing } to get full expansion text for error message
      let depth = 1;
      let j = i;
      while (j < value.length && depth > 0) {
        if (value[j] === "{") depth++;
        else if (value[j] === "}") depth--;
        if (depth > 0) j++;
      }
      const badText = value.slice(start + 2, j); // Content between ${ and }
      return {
        part: AST.parameterExpansion("", {
          type: "BadSubstitution",
          text: badText
        }),
        endIndex: j + 1
      };
    }
  }

  // Check for invalid parameter expansion with empty name and operator
  // e.g., ${%} or ${(x)foo} - there's no valid parameter before the operator
  // Instead of erroring at parse time, create a BadSubstitution operation
  // so the error is deferred to runtime (matching bash behavior where
  // code inside `if false; then ... fi` doesn't error)
  if (name === "" && !indirection && !lengthOp && value[i] !== "}") {
    // Find the closing } to get the full invalid text
    let depth = 1;
    let j = i;
    while (j < value.length && depth > 0) {
      if (value[j] === "{") depth++;
      else if (value[j] === "}") depth--;
      if (depth > 0) j++;
    }
    // If we didn't find a closing }, this is an unterminated expansion - throw parse error
    if (depth > 0) {
      throw new ParseException(
        "unexpected EOF while looking for matching '}'",
        0,
        0
      );
    }
    const badText = value.slice(start + 2, j); // Content between ${ and }
    return {
      part: AST.parameterExpansion("", {
        type: "BadSubstitution",
        text: badText
      }),
      endIndex: j + 1
    };
  }

  let operation: ParameterOperation | null = null;

  if (indirection) {
    // Check for ${!arr[@]} or ${!arr[*]} - array keys/indices
    // BUT only if there are no suffix operators - with operators it's indirect expansion
    const arrayKeysMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
    if (arrayKeysMatch) {
      // Check if there are additional operators (e.g., ${!ref[@]:2})
      // If so, this is indirect expansion through array values, not array keys
      if (
        i < value.length &&
        value[i] !== "}" &&
        /[:=\-+?#%/^,@]/.test(value[i])
      ) {
        // Parse as indirection with innerOp - the array expansion happens at runtime
        const opResult = parseParameterOperation(p, value, i, name, quoted);
        if (opResult.operation) {
          operation = {
            type: "Indirection",
            innerOp: opResult.operation as InnerParameterOperation
          };
          i = opResult.endIndex;
        } else {
          // Fallback to ArrayKeys if no operation parsed
          operation = {
            type: "ArrayKeys",
            array: arrayKeysMatch[1],
            star: arrayKeysMatch[2] === "*"
          };
          name = "";
        }
      } else {
        // No suffix operators - this is array keys
        operation = {
          type: "ArrayKeys",
          array: arrayKeysMatch[1],
          star: arrayKeysMatch[2] === "*"
        };
        // Clear name so it doesn't get treated as a variable
        name = "";
      }
    } else if (
      value[i] === "*" ||
      (value[i] === "@" && !/[QPaAEKkuUL]/.test(value[i + 1] || ""))
    ) {
      // Check for ${!prefix*} or ${!prefix@} - list variables with prefix
      // But NOT ${!var@P} which is indirection + @P transformation
      const suffix = value[i];
      i++; // Consume the * or @
      operation = {
        type: "VarNamePrefix",
        prefix: name,
        star: suffix === "*"
      };
      // Clear name so it doesn't get treated as a variable
      name = "";
    } else {
      // Simple indirection ${!ref} - but may have inner operation like ${!ref-default}
      // Check for additional operations after the variable name
      if (
        i < value.length &&
        value[i] !== "}" &&
        /[:=\-+?#%/^,@]/.test(value[i])
      ) {
        const opResult = parseParameterOperation(p, value, i, name, quoted);
        if (opResult.operation) {
          // Cast to InnerParameterOperation - parseParameterOperation only returns inner ops
          operation = {
            type: "Indirection",
            innerOp: opResult.operation as InnerParameterOperation
          };
          i = opResult.endIndex;
        } else {
          operation = { type: "Indirection" };
        }
      } else {
        operation = { type: "Indirection" };
      }
    }
  } else if (lengthOp) {
    // ${#var:...} is invalid - you can't take length of a substring
    // ${#var-...} is also invalid - length operator can't be followed by test operators
    // ${#var/...} is also invalid - length operator can't be followed by transform operators
    if (value[i] === ":") {
      // Mark this as an invalid length+slice operation
      // This will be handled at runtime to throw an error
      operation = { type: "LengthSliceError" } as ParameterOperation;
      // Skip past the invalid :offset:length part
      while (i < value.length && value[i] !== "}") {
        i++;
      }
    } else if (value[i] !== "}" && /[-+=?]/.test(value[i])) {
      // ${#x-default} etc. are syntax errors in bash
      // length operator cannot be followed by test operators
      p.error(
        `\${#${name}${value.slice(i, value.indexOf("}", i))}}: bad substitution`
      );
    } else if (value[i] === "/") {
      // ${#x/pattern/repl} is a syntax error in bash
      // length operator cannot be followed by transform operators
      p.error(
        `\${#${name}${value.slice(i, value.indexOf("}", i))}}: bad substitution`
      );
    } else {
      operation = { type: "Length" };
    }
  }

  // Parse operation
  if (!operation && i < value.length && value[i] !== "}") {
    const opResult = parseParameterOperation(p, value, i, name, quoted);
    operation = opResult.operation;
    i = opResult.endIndex;
  }

  // Check for invalid characters that indicate bad substitution
  // Valid characters after name are: }, :, -, +, =, ?, #, %, /, ^, ,, @, [
  if (i < value.length && value[i] !== "}") {
    const c = value[i];
    if (!/[:\-+=?#%/^,@[]/.test(c)) {
      // Find the full expansion for error message
      let endIdx = i;
      while (endIdx < value.length && value[endIdx] !== "}") endIdx++;
      const badExp = value.slice(start, endIdx + 1);
      p.error(`\${${badExp.slice(2, -1)}}: bad substitution`);
    }
  }

  // Find closing }
  while (i < value.length && value[i] !== "}") {
    i++;
  }

  // Check for unterminated expansion (no closing } found)
  if (i >= value.length) {
    throw new ParseException(
      "unexpected EOF while looking for matching '}'",
      0,
      0
    );
  }

  return {
    part: AST.parameterExpansion(name, operation),
    endIndex: i + 1
  };
}

function parseParameterOperation(
  p: Parser,
  value: string,
  start: number,
  _paramName: string,
  quoted = false
): { operation: ParameterOperation | null; endIndex: number } {
  let i = start;
  const char = value[i];
  const nextChar = value[i + 1] || "";

  // :- := :? :+ or :offset:length (substring)
  if (char === ":") {
    const op = nextChar;

    // Check if this is a special operator :- := :? :+
    if ("-=?+".includes(op)) {
      const checkEmpty = true;
      i += 2; // Skip : and operator

      const wordEnd = WordParser.findParameterOperationEnd(p, value, i);
      const wordStr = value.slice(i, wordEnd);
      // Parse the word for expansions (variables, arithmetic, command substitution)
      // When inside double quotes, single quotes should be literal, not quote delimiters
      const wordParts = parseWordParts(
        p,
        wordStr,
        false,
        false,
        true, // isAssignment=true for tilde expansion after : in default values
        false,
        quoted,
        false, // noBraceExpansion
        false, // regexPattern
        true // inParameterExpansion - so \} is treated as escaped }
      );
      const word = AST.word(ensureNonEmpty(wordParts));

      if (op === "-") {
        return {
          operation: { type: "DefaultValue", word, checkEmpty },
          endIndex: wordEnd
        };
      }
      if (op === "=") {
        return {
          operation: { type: "AssignDefault", word, checkEmpty },
          endIndex: wordEnd
        };
      }
      if (op === "?") {
        return {
          operation: { type: "ErrorIfUnset", word, checkEmpty },
          endIndex: wordEnd
        };
      }
      if (op === "+") {
        return {
          operation: { type: "UseAlternative", word, checkEmpty },
          endIndex: wordEnd
        };
      }
    }

    // Substring: ${var:offset} or ${var:offset:length}
    // Handle ternary expressions in offset: ${s: 0 < 1 ? 2 : 0 : 1}
    // The offset contains "0 < 1 ? 2 : 0" and length is "1"
    // We need to find the colon that separates offset from length
    i++; // Skip only the first :
    const wordEnd = WordParser.findParameterOperationEnd(p, value, i);
    const wordStr = value.slice(i, wordEnd);

    // Find the separator colon that's NOT part of a ternary expression
    // A ternary colon is preceded (somewhere) by a ? at the same depth
    // We track if we've seen a ? and skip the : that follows it
    let colonIdx = -1;
    let depth = 0;
    let ternaryDepth = 0; // Tracks ternary nesting
    for (let j = 0; j < wordStr.length; j++) {
      const c = wordStr[j];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "?" && depth === 0) ternaryDepth++;
      else if (c === ":" && depth === 0) {
        if (ternaryDepth > 0) {
          // This is a ternary colon, not the separator
          ternaryDepth--;
        } else {
          // This is the offset:length separator
          colonIdx = j;
          break;
        }
      }
    }

    const offsetStr = colonIdx >= 0 ? wordStr.slice(0, colonIdx) : wordStr;
    const lengthStr = colonIdx >= 0 ? wordStr.slice(colonIdx + 1) : null;
    return {
      operation: {
        type: "Substring",
        offset: WordParser.parseArithExprFromString(p, offsetStr),
        // Note: lengthStr can be "" (empty string after second colon like ${a::})
        // which should be treated as length 0, not "no length specified"
        length:
          lengthStr !== null
            ? WordParser.parseArithExprFromString(p, lengthStr)
            : null
      },
      endIndex: wordEnd
    };
  }

  // - = ? + (without colon)
  if ("-=?+".includes(char)) {
    i++;
    const wordEnd = WordParser.findParameterOperationEnd(p, value, i);
    const wordStr = value.slice(i, wordEnd);
    // Parse the word for expansions (variables, arithmetic, command substitution)
    // When inside double quotes, single quotes should be literal, not quote delimiters
    const wordParts = parseWordParts(
      p,
      wordStr,
      false,
      false,
      true, // isAssignment=true for tilde expansion after : in default values
      false,
      quoted,
      false, // noBraceExpansion
      false, // regexPattern
      true // inParameterExpansion - so \} is treated as escaped }
    );
    const word = AST.word(ensureNonEmpty(wordParts));

    if (char === "-") {
      return {
        operation: { type: "DefaultValue", word, checkEmpty: false },
        endIndex: wordEnd
      };
    }
    if (char === "=") {
      return {
        operation: { type: "AssignDefault", word, checkEmpty: false },
        endIndex: wordEnd
      };
    }
    if (char === "?") {
      return {
        operation: {
          type: "ErrorIfUnset",
          word: wordStr ? word : null,
          checkEmpty: false
        },
        endIndex: wordEnd
      };
    }
    if (char === "+") {
      return {
        operation: { type: "UseAlternative", word, checkEmpty: false },
        endIndex: wordEnd
      };
    }
  }

  // ## # %% % pattern removal
  if (char === "#" || char === "%") {
    const greedy = nextChar === char;
    const side = char === "#" ? "prefix" : "suffix";
    i += greedy ? 2 : 1;

    const patternEnd = WordParser.findParameterOperationEnd(p, value, i);
    const patternStr = value.slice(i, patternEnd);
    // Parse the pattern for variable expansions and quoting (like PatternReplacement)
    const patternParts = parseWordParts(p, patternStr, false, false, false);
    const pattern = AST.word(ensureNonEmpty(patternParts));

    return {
      operation: { type: "PatternRemoval", pattern, side, greedy },
      endIndex: patternEnd
    };
  }

  // / // pattern replacement
  if (char === "/") {
    const all = nextChar === "/";
    i += all ? 2 : 1;

    // Check for anchor
    let anchor: "start" | "end" | null = null;
    if (value[i] === "#") {
      anchor = "start";
      i++;
    } else if (value[i] === "%") {
      anchor = "end";
      i++;
    }

    // Find pattern/replacement separator
    // Special case: if we have an anchor and the next char is / or }, the pattern is empty
    // This handles ${var/#/replacement} (prepend) and ${var/%/replacement} (append)
    let patternEnd: number;
    if (anchor !== null && (value[i] === "/" || value[i] === "}")) {
      patternEnd = i; // Pattern is empty
    } else {
      patternEnd = WordParser.findPatternEnd(p, value, i);
    }
    const patternStr = value.slice(i, patternEnd);
    // Parse the pattern for variable expansions (e.g., ${var//$pat/repl})
    const patternParts = parseWordParts(p, patternStr, false, false, false);
    const pattern = AST.word(ensureNonEmpty(patternParts));

    let replacement: WordNode | null = null;
    let endIdx = patternEnd;

    if (value[patternEnd] === "/") {
      const replaceStart = patternEnd + 1;
      const replaceEnd = WordParser.findParameterOperationEnd(
        p,
        value,
        replaceStart
      );
      const replaceStr = value.slice(replaceStart, replaceEnd);
      // Parse the replacement for variable expansions
      const replaceParts = parseWordParts(p, replaceStr, false, false, false);
      replacement = AST.word(ensureNonEmpty(replaceParts));
      endIdx = replaceEnd;
    }

    return {
      operation: {
        type: "PatternReplacement",
        pattern,
        replacement,
        all,
        anchor
      },
      endIndex: endIdx
    };
  }

  // ^ ^^ , ,, case modification
  if (char === "^" || char === ",") {
    const all = nextChar === char;
    const direction = char === "^" ? "upper" : "lower";
    i += all ? 2 : 1;

    const patternEnd = WordParser.findParameterOperationEnd(p, value, i);
    const patternStr = value.slice(i, patternEnd);
    const pattern = patternStr ? AST.word([AST.literal(patternStr)]) : null;

    return {
      operation: {
        type: "CaseModification",
        direction,
        all,
        pattern
      } as const,
      endIndex: patternEnd
    };
  }

  // @Q @P @a @A @E @K @k @u @U @L transformations
  if (char === "@" && /[QPaAEKkuUL]/.test(nextChar)) {
    const operator = nextChar as
      | "Q"
      | "P"
      | "a"
      | "A"
      | "E"
      | "K"
      | "k"
      | "u"
      | "U"
      | "L";
    return {
      operation: {
        type: "Transform",
        operator
      } as const,
      endIndex: i + 2
    };
  }

  return { operation: null, endIndex: i };
}

function parseExpansion(
  p: Parser,
  value: string,
  start: number,
  quoted = false
): { part: WordPart | null; endIndex: number } {
  // $ at start
  const i = start + 1;

  if (i >= value.length) {
    return { part: AST.literal("$"), endIndex: i };
  }

  const char = value[i];

  // $((expr)) - arithmetic expansion OR $((cmd) ...) - command substitution with nested subshell
  // We need to check if this is arithmetic (closes with )) or command sub (closes with ) ))
  if (char === "(" && value[i + 1] === "(") {
    // Check if this should be parsed as a subshell instead of arithmetic
    if (p.isDollarDparenSubshell(value, start)) {
      // Parse as command substitution - the $(( should be treated as $( with inner (
      return p.parseCommandSubstitution(value, start);
    }
    return p.parseArithmeticExpansion(value, start);
  }

  // $[expr] - old-style arithmetic expansion (synonym for $((expr)))
  if (char === "[") {
    // Find matching ]
    let depth = 1;
    let j = i + 1;
    while (j < value.length && depth > 0) {
      if (value[j] === "[") depth++;
      else if (value[j] === "]") depth--;
      if (depth > 0) j++;
    }
    if (depth === 0) {
      const expr = value.slice(i + 1, j);
      // Create ArithmeticExpansion node (wraps the expression)
      const arithExpr = parseArithmeticExpression(p, expr);
      return { part: AST.arithmeticExpansion(arithExpr), endIndex: j + 1 };
    }
  }

  // $(cmd) - command substitution
  if (char === "(") {
    return p.parseCommandSubstitution(value, start);
  }

  // ${...} - parameter expansion with operators
  if (char === "{") {
    return parseParameterExpansion(p, value, start, quoted);
  }

  // $VAR or $1 or $@ etc - simple parameter
  if (/[a-zA-Z_0-9@*#?$!-]/.test(char)) {
    return parseSimpleParameter(p, value, start);
  }

  // Just a literal $
  return { part: AST.literal("$"), endIndex: i };
}

function parseDoubleQuotedContent(p: Parser, value: string): WordPart[] {
  const parts: WordPart[] = [];
  let i = 0;
  let literal = "";

  const flushLiteral = () => {
    if (literal) {
      parts.push(AST.literal(literal));
      literal = "";
    }
  };

  while (i < value.length) {
    const char = value[i];

    // Handle escape sequences in double quotes
    // In bash double quotes, \$ \` \" \\ all have the backslash removed
    // "\$HOME" outputs "$HOME", "say \"hi\"" outputs 'say "hi"'
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      // \$ \` \" \\ have backslash removed, result in just the escaped char
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        literal += next; // Add just the escaped character, not the backslash
        i += 2;
        continue;
      }
      // Other backslash sequences: just add the backslash and continue
      literal += char;
      i++;
      continue;
    }

    // Handle $ expansions
    if (char === "$") {
      flushLiteral();
      // Pass quoted=true since we're inside double quotes
      const { part, endIndex } = parseExpansion(p, value, i, true);
      if (part) {
        parts.push(part);
      }
      i = endIndex;
      continue;
    }

    // Handle backtick command substitution
    if (char === "`") {
      flushLiteral();
      // Pass true since we're inside double quotes
      const { part, endIndex } = p.parseBacktickSubstitution(value, i, true);
      parts.push(part);
      i = endIndex;
      continue;
    }

    // All other characters are literal (including " and ' which are already processed)
    literal += char;
    i++;
  }

  flushLiteral();
  return parts;
}

function parseDoubleQuoted(
  p: Parser,
  value: string,
  start: number
): { part: WordPart; endIndex: number } {
  const innerParts: WordPart[] = [];
  let i = start;
  let literal = "";

  const flushLiteral = () => {
    if (literal) {
      innerParts.push(AST.literal(literal));
      literal = "";
    }
  };

  while (i < value.length && value[i] !== '"') {
    const char = value[i];

    // Handle escapes in double quotes
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if ('"\\$`\n'.includes(next)) {
        literal += next;
        i += 2;
        continue;
      }
      literal += char;
      i++;
      continue;
    }

    // Handle $ expansions
    if (char === "$") {
      flushLiteral();
      // Pass quoted=true since we're inside double quotes
      const { part, endIndex } = parseExpansion(p, value, i, true);
      if (part) {
        innerParts.push(part);
      }
      i = endIndex;
      continue;
    }

    // Handle backtick
    if (char === "`") {
      flushLiteral();
      // Pass true since we're inside double quotes
      const { part, endIndex } = p.parseBacktickSubstitution(value, i, true);
      innerParts.push(part);
      i = endIndex;
      continue;
    }

    literal += char;
    i++;
  }

  flushLiteral();

  return {
    part: AST.doubleQuoted(innerParts),
    endIndex: i
  };
}

export function parseWordParts(
  p: Parser,
  value: string,
  quoted = false,
  singleQuoted = false,
  isAssignment = false,
  hereDoc = false,
  /** When true, single quotes are treated as literal characters, not quote delimiters */
  singleQuotesAreLiteral = false,
  /** When true, brace expansion is disabled (used in [[ ]] conditionals) */
  noBraceExpansion = false,
  /** When true, all backslash escapes create Escaped nodes (for regex patterns in [[ =~ ]]) */
  regexPattern = false,
  /** When true, \} is treated as escaped } (used in parameter expansion default values) */
  inParameterExpansion = false
): WordPart[] {
  if (singleQuoted) {
    // Single quotes: no expansion
    return [AST.singleQuoted(value)];
  }

  // When quoted=true, the lexer has already stripped outer quotes and processed escapes
  // We need to wrap the result in a DoubleQuoted node, but still process $ expansions
  if (quoted) {
    const innerParts = parseDoubleQuotedContent(p, value);
    return [AST.doubleQuoted(innerParts)];
  }

  // Check if value is a fully double-quoted string (starts and ends with " with no unescaped " inside)
  // This handles cases like assignment values where the token isn't marked as quoted
  // e.g., v="\\" where the value portion is "\"
  if (
    value.length >= 2 &&
    value[0] === '"' &&
    value[value.length - 1] === '"'
  ) {
    const inner = value.slice(1, -1);
    // Check for unescaped double quotes inside
    let hasUnescapedQuote = false;
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] === '"') {
        hasUnescapedQuote = true;
        break;
      }
      if (inner[j] === "\\" && j + 1 < inner.length) {
        j++; // Skip escaped char
      }
    }
    if (!hasUnescapedQuote) {
      // It's a fully double-quoted string - parse the inner content
      const innerParts = parseDoubleQuotedContent(p, inner);
      return [AST.doubleQuoted(innerParts)];
    }
  }

  const parts: WordPart[] = [];
  let i = 0;
  let literal = "";

  const flushLiteral = () => {
    if (literal) {
      parts.push(AST.literal(literal));
      literal = "";
    }
  };

  while (i < value.length) {
    const char = value[i];

    // Handle escape sequences
    // In unquoted context, only certain characters are escapable
    // In here-docs, only $, `, \, newline are escapable (NOT ")
    // In regular words, $, `, \, ", newline are escapable
    // Glob metacharacters (*, ?, [, ]) when escaped should create Escaped nodes
    // so they're treated as literals during globbing
    // In regex patterns, ALL escaped characters create Escaped nodes so the backslash
    // is preserved for the regex engine (e.g., \$ matches literal $)
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];

      // In regex patterns, all escaped characters create Escaped nodes
      // This preserves the backslash for the regex engine
      if (regexPattern) {
        flushLiteral();
        parts.push(AST.escaped(next));
        i += 2;
        continue;
      }

      // Characters that should be escaped (result in just the literal char)
      // Inside parameter expansion default values, \} is also escapable to produce }
      const isEscapable = hereDoc
        ? next === "$" || next === "`" || next === "\n"
        : next === "$" ||
          next === "`" ||
          next === '"' ||
          next === "'" ||
          next === "\n" ||
          (inParameterExpansion && next === "}");
      // Glob metacharacters, extglob operators, braces, and backslash that should create Escaped nodes
      // so they're treated as literals during globbing (and \\ doesn't escape the next char)
      // Including ( and ) to prevent \( and \) from being interpreted as extglob operators
      // Including { and } to prevent \{ and \} from being interpreted as brace expansion
      // Including regex metacharacters (. ^ +) so they create Escaped nodes for [[ =~ ]] patterns
      // BUT: inside double quotes (singleQuotesAreLiteral=true), ( ) { } . ^ + are NOT escapable
      // because double quotes only allow escaping $, `, ", \, and newline
      const isGlobMetaOrBackslash = singleQuotesAreLiteral
        ? "*?[]\\".includes(next)
        : "*?[]\\(){}.^+".includes(next);
      if (isEscapable) {
        literal += next;
      } else if (isGlobMetaOrBackslash) {
        // Create an Escaped node for glob metacharacters and backslash
        flushLiteral();
        parts.push(AST.escaped(next));
      } else {
        // Keep the backslash for non-special characters
        literal += `\\${next}`;
      }
      i += 2;
      continue;
    }

    // Handle single quotes
    // When inside double-quoted context (singleQuotesAreLiteral=true), single quotes
    // are literal characters, not quote delimiters
    // In here-docs, quotes are NOT special - they're literal characters
    if (char === "'" && !singleQuotesAreLiteral && !hereDoc) {
      flushLiteral();
      const closeQuote = value.indexOf("'", i + 1);
      if (closeQuote === -1) {
        literal += value.slice(i);
        break;
      }
      parts.push(AST.singleQuoted(value.slice(i + 1, closeQuote)));
      i = closeQuote + 1;
      continue;
    }

    // Handle double quotes
    // In here-docs, quotes are NOT special - they're literal characters
    // Only $, `, and \ are special in heredocs (for expansion and escaping)
    if (char === '"' && !hereDoc) {
      flushLiteral();
      const { part, endIndex } = parseDoubleQuoted(p, value, i + 1);
      parts.push(part);
      i = endIndex + 1;
      continue;
    }

    // Handle $'' ANSI-C quoting (must check before regular $ expansion)
    if (char === "$" && value[i + 1] === "'") {
      flushLiteral();
      const { part, endIndex } = WordParser.parseAnsiCQuoted(p, value, i + 2);
      parts.push(part);
      i = endIndex;
      continue;
    }

    // Handle $ expansions
    if (char === "$") {
      flushLiteral();
      const { part, endIndex } = parseExpansion(p, value, i);
      if (part) {
        parts.push(part);
      }
      i = endIndex;
      continue;
    }

    // Handle backtick command substitution
    if (char === "`") {
      flushLiteral();
      const { part, endIndex } = p.parseBacktickSubstitution(value, i);
      parts.push(part);
      i = endIndex;
      continue;
    }

    // Handle tilde expansion
    if (char === "~") {
      const prevChar = i > 0 ? value[i - 1] : "";
      const canExpandAfterColon = isAssignment && prevChar === ":";
      if (i === 0 || prevChar === "=" || canExpandAfterColon) {
        const tildeEnd = WordParser.findTildeEnd(p, value, i);
        const afterTilde = value[tildeEnd];
        if (
          afterTilde === undefined ||
          afterTilde === "/" ||
          afterTilde === ":"
        ) {
          flushLiteral();
          const user = value.slice(i + 1, tildeEnd) || null;
          parts.push({ type: "TildeExpansion", user });
          i = tildeEnd;
          continue;
        }
      }
    }

    // Handle extglob patterns: @(...), *(...), +(...), ?(...), !(...)
    // These must be checked BEFORE regular glob patterns because * and ? are both
    // extglob operators and glob characters
    if (
      "@*+?!".includes(char) &&
      i + 1 < value.length &&
      value[i + 1] === "("
    ) {
      // Find the matching closing paren
      const closeIdx = findExtglobClose(value, i + 1);
      if (closeIdx !== -1) {
        flushLiteral();
        // Include the entire extglob pattern including the operator and parens
        const pattern = value.slice(i, closeIdx + 1);
        parts.push({ type: "Glob", pattern });
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle glob patterns
    if (char === "*" || char === "?" || char === "[") {
      flushLiteral();
      const { pattern, endIndex } = WordParser.parseGlobPattern(p, value, i);
      parts.push({ type: "Glob", pattern });
      i = endIndex;
      continue;
    }

    // Handle brace expansion
    // (but NOT on the RHS of assignments, in [[ ]] conditionals, or in heredocs)
    if (char === "{" && !isAssignment && !noBraceExpansion && !hereDoc) {
      const braceResult = WordParser.tryParseBraceExpansion(
        p,
        value,
        i,
        parseWordParts
      );
      if (braceResult) {
        flushLiteral();
        parts.push(braceResult.part);
        i = braceResult.endIndex;
        continue;
      }
    }

    // Regular character
    literal += char;
    i++;
  }

  flushLiteral();
  return parts;
}
