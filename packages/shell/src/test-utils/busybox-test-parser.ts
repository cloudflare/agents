/**
 * Shared parser for BusyBox test format
 *
 * BusyBox format: testing "description" "commands" "result" "infile" "stdin"
 *
 * This parser is used by both sed-spec-tests and grep-spec-tests.
 */

export interface BusyBoxTestCase {
  name: string;
  /** The shell command to run */
  command: string;
  /** Expected stdout */
  expectedOutput: string;
  /** Content for input file (if any) */
  infile: string;
  /** Content for stdin (if any) */
  stdin: string;
  /** Line number in source file */
  lineNumber: number;
  /** If set, test is expected to fail (value is reason) */
  skip?: string;
  /** Expected exit code (optional - if not set, only output is checked) */
  expectedExitCode?: number;
}

export interface ParsedBusyBoxTestFile {
  fileName: string;
  filePath: string;
  testCases: BusyBoxTestCase[];
}

/**
 * Join multi-line test definitions, handling both shell continuations and quoted newlines
 * - Shell continuation: backslash at end of line (outside quotes OR inside double quotes) -> remove backslash, join
 * - Escaped backslash at end of line (\\): not a continuation, preserve newline
 * - Quoted newline inside single quotes: preserve the newline (backslash is literal in single quotes)
 */
function joinTestLines(
  lines: string[],
  startIndex: number
): { fullLine: string; endIndex: number } {
  let result = "";
  let i = startIndex;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < lines.length) {
    const line = lines[i];

    // Process each character to track quote state
    for (let j = 0; j < line.length; j++) {
      const char = line[j];

      // Handle escape sequences (but only in double quotes for shell)
      if (char === "\\" && j + 1 < line.length && inDoubleQuote) {
        result += char + line[j + 1];
        j++;
        continue;
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      }

      result += char;
    }

    // Count trailing backslashes in the original line
    // Odd count = trailing continuation backslash
    // Even count = all backslashes are escaped (no continuation)
    let trailingBackslashes = 0;
    for (let k = line.length - 1; k >= 0 && line[k] === "\\"; k--) {
      trailingBackslashes++;
    }
    const hasTrailingContinuation = trailingBackslashes % 2 === 1;

    // Shell continuation applies:
    // - Outside quotes with trailing backslash
    // - Inside double quotes with trailing backslash (not escaped)
    // - NOT inside single quotes (backslash is literal there)
    const isShellContinuation = hasTrailingContinuation && !inSingleQuote;

    if (isShellContinuation) {
      // Remove the trailing backslash and continue to next line
      result = result.slice(0, -1);
      i++;
    } else if (inSingleQuote || inDoubleQuote) {
      // We're inside a quoted string - add newline and continue
      result += "\n";
      i++;
    } else {
      // Line is complete (not in quotes, no continuation)
      break;
    }
  }

  return { fullLine: result, endIndex: i };
}

/**
 * Parse quoted arguments from a string
 * Handles both single and double quoted strings
 */
function parseQuotedArgs(str: string): string[] {
  const args: string[] = [];
  let i = 0;

  while (i < str.length) {
    // Skip whitespace
    while (i < str.length && /\s/.test(str[i])) {
      i++;
    }

    if (i >= str.length) break;

    const quote = str[i];
    if (quote !== '"' && quote !== "'") {
      // Unquoted argument - read until whitespace
      let arg = "";
      while (i < str.length && !/\s/.test(str[i])) {
        arg += str[i];
        i++;
      }
      args.push(arg);
      continue;
    }

    // Quoted argument - may have adjacent quotes like "a""b" which means "ab"
    let arg = "";
    while (i < str.length && (str[i] === '"' || str[i] === "'")) {
      const currentQuote = str[i];
      i++; // skip opening quote
      while (i < str.length && str[i] !== currentQuote) {
        if (str[i] === "\\" && i + 1 < str.length) {
          // Handle escape sequences
          arg += str[i] + str[i + 1];
          i += 2;
        } else {
          arg += str[i];
          i++;
        }
      }
      i++; // skip closing quote
    }
    args.push(arg);
  }

  return args;
}

/**
 * Unescape shell string escapes
 */
function unescapeString(str: string): string {
  return str
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

/**
 * Unescape shell double-quote escapes in commands
 * This mimics bash's double-quote expansion where:
 * - \$ becomes $ (escaping the special meaning)
 * - \\ becomes \ (escaped backslash)
 * - \" becomes "
 * - \` becomes `
 * - \<newline> removes the backslash and newline (line continuation)
 * - All other \X sequences are left as-is (\n, \t, etc. are NOT interpreted)
 *
 * Uses single-pass processing to avoid multi-level unescaping issues.
 */
function unescapeCommand(str: string): string {
  let result = "";
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (char === "\\" && i + 1 < str.length) {
      const next = str[i + 1];
      // In bash double quotes, only these characters are escaped: $ ` " \ newline
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        result += next;
        i += 2;
        continue;
      }
      // \newline in double quotes removes both (line continuation)
      if (next === "\n") {
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse BusyBox test format
 *
 * Format: testing "description" "commands" "result" "infile" "stdin"
 */
export function parseBusyBoxTests(
  content: string,
  filePath: string
): ParsedBusyBoxTestFile {
  const fileName = filePath.split("/").pop() || filePath;
  const lines = content.split("\n");
  const testCases: BusyBoxTestCase[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") {
      continue;
    }

    // Look for testing "..." "..." "..." "..." "..."
    // Handle multi-line tests with proper quote tracking
    const { fullLine, endIndex } = joinTestLines(lines, i);
    i = endIndex;

    const testMatch = fullLine.match(/^testing\s+"([^"]*)"\s+([\s\S]+)$/);

    if (!testMatch) {
      continue;
    }

    const description = testMatch[1];
    const rest = testMatch[2];

    // Parse the remaining arguments - they're quoted strings
    const args = parseQuotedArgs(rest);

    if (args.length < 4) {
      continue;
    }

    const [command, result, infile, stdin] = args;

    testCases.push({
      name: description,
      // Unescape shell double-quote escapes (\$ -> $) but keep sed escapes (\n, \t)
      command: unescapeCommand(command),
      expectedOutput: unescapeString(result),
      infile: unescapeString(infile),
      stdin: unescapeString(stdin),
      lineNumber: i + 1
    });
  }

  return { fileName, filePath, testCases };
}
