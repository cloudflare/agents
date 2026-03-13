/**
 * Array Parsing Functions for declare/typeset
 *
 * Handles parsing of array literal syntax for the declare builtin.
 */

/**
 * Parse array elements from content like "1 2 3" or "'a b' c d"
 */
export function parseArrayElements(content: string): string[] {
  const elements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  // Track whether we've seen content that should result in an element,
  // including empty quoted strings like '' or ""
  let hasContent = false;

  for (const char of content) {
    if (escaped) {
      current += char;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      // Entering or leaving single quotes - either way, this indicates an element exists
      if (!inSingleQuote) {
        // Entering quotes - mark that we have content (even if empty)
        hasContent = true;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      // Entering or leaving double quotes - either way, this indicates an element exists
      if (!inDoubleQuote) {
        // Entering quotes - mark that we have content (even if empty)
        hasContent = true;
      }
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (
      (char === " " || char === "\t" || char === "\n") &&
      !inSingleQuote &&
      !inDoubleQuote
    ) {
      if (hasContent) {
        elements.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) {
    elements.push(current);
  }
  return elements;
}

/**
 * Parse associative array literal content like "['foo']=bar ['spam']=42"
 * Returns array of [key, value] pairs
 */
export function parseAssocArrayLiteral(content: string): [string, string][] {
  const entries: [string, string][] = [];
  let pos = 0;

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }
    if (pos >= content.length) break;

    // Expect [
    if (content[pos] !== "[") {
      // Skip non-bracket content
      pos++;
      continue;
    }
    pos++; // skip [

    // Parse key (may be quoted)
    let key = "";
    if (content[pos] === "'" || content[pos] === '"') {
      const quote = content[pos];
      pos++;
      while (pos < content.length && content[pos] !== quote) {
        key += content[pos];
        pos++;
      }
      if (content[pos] === quote) pos++;
    } else {
      while (
        pos < content.length &&
        content[pos] !== "]" &&
        content[pos] !== "="
      ) {
        key += content[pos];
        pos++;
      }
    }

    // Skip to ]
    while (pos < content.length && content[pos] !== "]") {
      pos++;
    }
    if (content[pos] === "]") pos++;

    // Expect =
    if (content[pos] !== "=") continue;
    pos++;

    // Parse value (may be quoted)
    let value = "";
    if (content[pos] === "'" || content[pos] === '"') {
      const quote = content[pos];
      pos++;
      while (pos < content.length && content[pos] !== quote) {
        if (content[pos] === "\\" && pos + 1 < content.length) {
          pos++;
          value += content[pos];
        } else {
          value += content[pos];
        }
        pos++;
      }
      if (content[pos] === quote) pos++;
    } else {
      while (pos < content.length && !/\s/.test(content[pos])) {
        value += content[pos];
        pos++;
      }
    }

    entries.push([key, value]);
  }

  return entries;
}
