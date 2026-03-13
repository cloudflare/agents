/**
 * Core content matching logic for search commands
 */

import type { UserRegex } from "../../regex/index";

/**
 * Apply a replacement pattern using capture groups from a regex match
 * Supports: $& (full match), $1-$9 (numbered groups), $<name> (named groups)
 */
function applyReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(
    /\$(&|\d+|<([^>]+)>)/g,
    (_, ref: string, namedGroup: string | undefined) => {
      if (ref === "&") {
        return match[0];
      }
      if (namedGroup !== undefined) {
        // Named group: $<name>
        return match.groups?.[namedGroup] ?? "";
      }
      // Numbered group: $1, $2, etc.
      const groupNum = parseInt(ref, 10);
      return match[groupNum] ?? "";
    }
  );
}

export interface SearchOptions {
  /** Select non-matching lines */
  invertMatch?: boolean;
  /** Print line number with output lines */
  showLineNumbers?: boolean;
  /** Print only a count of matching lines */
  countOnly?: boolean;
  /** Count individual matches instead of lines (--count-matches) */
  countMatches?: boolean;
  /** Filename prefix for output (empty string for no prefix) */
  filename?: string;
  /** Show only the matching parts of lines */
  onlyMatching?: boolean;
  /** Print NUM lines of leading context */
  beforeContext?: number;
  /** Print NUM lines of trailing context */
  afterContext?: number;
  /** Stop after NUM matches (0 = unlimited) */
  maxCount?: number;
  /** Separator between context groups (default: --) */
  contextSeparator?: string;
  /** Show column number of first match */
  showColumn?: boolean;
  /** Output each match separately (vimgrep format) */
  vimgrep?: boolean;
  /** Show byte offset of each match */
  showByteOffset?: boolean;
  /** Replace matched text with this string */
  replace?: string | null;
  /** Print all lines (matches use :, non-matches use -) */
  passthru?: boolean;
  /** Enable multiline matching (patterns can span lines) */
  multiline?: boolean;
  /** If \K was used, this is the capture group index containing the "real" match */
  kResetGroup?: number;
}

export interface SearchResult {
  /** The formatted output string */
  output: string;
  /** Whether any matches were found */
  matched: boolean;
  /** Number of matches found */
  matchCount: number;
}

/**
 * Search content for regex matches and format output
 *
 * Handles:
 * - Count only mode (-c)
 * - Line numbers (-n)
 * - Invert match (-v)
 * - Only matching (-o)
 * - Context lines (-A, -B, -C)
 * - Max count (-m)
 */
export function searchContent(
  content: string,
  regex: UserRegex,
  options: SearchOptions = {}
): SearchResult {
  const {
    invertMatch = false,
    showLineNumbers = false,
    countOnly = false,
    countMatches = false,
    filename = "",
    onlyMatching = false,
    beforeContext = 0,
    afterContext = 0,
    maxCount = 0,
    contextSeparator = "--",
    showColumn = false,
    vimgrep = false,
    showByteOffset = false,
    replace = null,
    passthru = false,
    multiline = false,
    kResetGroup
  } = options;

  // Multiline mode: search entire content as one string
  if (multiline) {
    return searchContentMultiline(content, regex, {
      invertMatch,
      showLineNumbers,
      countOnly,
      countMatches,
      filename,
      onlyMatching,
      beforeContext,
      afterContext,
      maxCount,
      contextSeparator,
      showColumn,
      showByteOffset,
      replace,
      kResetGroup
    });
  }

  const lines = content.split("\n");
  const lineCount = lines.length;
  // Handle trailing empty line from split if content ended with newline
  const lastIdx =
    lineCount > 0 && lines[lineCount - 1] === "" ? lineCount - 1 : lineCount;

  // Fast path: count only mode
  if (countOnly || countMatches) {
    let matchCount = 0;
    // --count --only-matching behaves like --count-matches
    const shouldCountMatches = (countMatches || onlyMatching) && !invertMatch;
    for (let i = 0; i < lastIdx; i++) {
      regex.lastIndex = 0;
      if (shouldCountMatches) {
        // Count individual matches on the line
        for (
          let match = regex.exec(lines[i]);
          match !== null;
          match = regex.exec(lines[i])
        ) {
          matchCount++;
          if (match[0].length === 0) regex.lastIndex++;
        }
      } else {
        // Count lines (with matches, or without matches if inverted)
        if (regex.test(lines[i]) !== invertMatch) {
          matchCount++;
        }
      }
    }
    const countStr = filename
      ? `${filename}:${matchCount}`
      : String(matchCount);
    return { output: `${countStr}\n`, matched: matchCount > 0, matchCount };
  }

  // Fast path: no context needed (most common case)
  if (beforeContext === 0 && afterContext === 0 && !passthru) {
    const outputLines: string[] = [];
    let hasMatch = false;
    let matchCount = 0;
    let byteOffset = 0; // Track cumulative byte offset

    for (let i = 0; i < lastIdx; i++) {
      // Check if we've reached maxCount
      if (maxCount > 0 && matchCount >= maxCount) break;

      const line = lines[i];
      regex.lastIndex = 0;
      const matches = regex.test(line);

      if (matches !== invertMatch) {
        hasMatch = true;
        matchCount++;
        if (onlyMatching) {
          regex.lastIndex = 0;
          for (
            let match = regex.exec(line);
            match !== null;
            match = regex.exec(line)
          ) {
            // If \K was used, extract from the capture group instead of full match
            const rawMatch =
              kResetGroup !== undefined ? (match[kResetGroup] ?? "") : match[0];
            const matchText =
              replace !== null ? applyReplacement(replace, match) : rawMatch;
            let prefix = filename ? `${filename}:` : "";
            if (showByteOffset) prefix += `${byteOffset + match.index}:`;
            if (showLineNumbers) prefix += `${i + 1}:`;
            if (showColumn) prefix += `${match.index + 1}:`;
            outputLines.push(prefix + matchText);
            if (match[0].length === 0) regex.lastIndex++;
          }
        } else if (vimgrep) {
          // Vimgrep mode: output each match separately with full line
          regex.lastIndex = 0;
          for (
            let match = regex.exec(line);
            match !== null;
            match = regex.exec(line)
          ) {
            let prefix = filename ? `${filename}:` : "";
            if (showByteOffset) prefix += `${byteOffset + match.index}:`;
            if (showLineNumbers) prefix += `${i + 1}:`;
            if (showColumn) prefix += `${match.index + 1}:`;
            outputLines.push(prefix + line);
            if (match[0].length === 0) regex.lastIndex++;
          }
        } else {
          // Get first match position for column
          regex.lastIndex = 0;
          const firstMatch = regex.exec(line);
          const column = firstMatch ? firstMatch.index + 1 : 1;

          // Apply replacement if specified
          let outputLine = line;
          if (replace !== null) {
            regex.lastIndex = 0;
            // Use replacer function to skip empty matches (ripgrep behavior)
            outputLine = regex.replace(line, (...args) => {
              const matchText = args[0] as string;
              // Skip empty matches to avoid double replacement with patterns like .*
              if (matchText.length === 0) return "";
              // Build match object for applyReplacement
              // String.replace args: match, p1, p2, ..., offset, string, [groups]
              const match = args as unknown as RegExpExecArray;
              // Check if last arg is groups object (string input is always a string)
              const lastArg = args[args.length - 1];
              if (typeof lastArg === "object" && lastArg !== null) {
                // Has named groups
                match.groups = lastArg as Record<string, string>;
                match.input = args[args.length - 2] as string;
                match.index = args[args.length - 3] as number;
              } else {
                // No named groups
                match.input = args[args.length - 1] as string;
                match.index = args[args.length - 2] as number;
              }
              return applyReplacement(replace, match);
            });
          }

          let prefix = filename ? `${filename}:` : "";
          if (showByteOffset)
            prefix += `${byteOffset + (firstMatch ? firstMatch.index : 0)}:`;
          if (showLineNumbers) prefix += `${i + 1}:`;
          if (showColumn) prefix += `${column}:`;
          outputLines.push(prefix + outputLine);
        }
      }

      // Update byte offset for next line (+1 for newline)
      byteOffset += line.length + 1;
    }

    return {
      output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
      matched: hasMatch,
      matchCount
    };
  }

  // Passthru mode: print all lines, matches use :, non-matches use -
  if (passthru) {
    const outputLines: string[] = [];
    let hasMatch = false;
    let matchCount = 0;

    for (let i = 0; i < lastIdx; i++) {
      const line = lines[i];
      regex.lastIndex = 0;
      const matches = regex.test(line);
      const isMatch = matches !== invertMatch;

      if (isMatch) {
        hasMatch = true;
        matchCount++;
      }

      // Separator: : for matches, - for non-matches
      const sep = isMatch ? ":" : "-";

      let prefix = filename ? `${filename}${sep}` : "";
      if (showLineNumbers) prefix += `${i + 1}${sep}`;
      outputLines.push(prefix + line);
    }

    return {
      output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
      matched: hasMatch,
      matchCount
    };
  }

  // Slow path: context lines needed
  const outputLines: string[] = [];
  let matchCount = 0;
  const printedLines = new Set<number>();
  let lastPrintedLine = -1;

  // First pass: find all matching lines (respecting maxCount)
  const matchingLineNumbers: number[] = [];
  for (let i = 0; i < lastIdx; i++) {
    // Check if we've reached maxCount
    if (maxCount > 0 && matchCount >= maxCount) break;
    regex.lastIndex = 0;
    if (regex.test(lines[i]) !== invertMatch) {
      matchingLineNumbers.push(i);
      matchCount++;
    }
  }

  // Second pass: output with context
  for (const lineNum of matchingLineNumbers) {
    const contextStart = Math.max(0, lineNum - beforeContext);

    // Add separator if there's a gap between this group and the last printed line
    if (lastPrintedLine >= 0 && contextStart > lastPrintedLine + 1) {
      outputLines.push(contextSeparator);
    }

    // Before context
    for (let i = contextStart; i < lineNum; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let outputLine = lines[i];
        if (showLineNumbers) outputLine = `${i + 1}-${outputLine}`;
        if (filename) outputLine = `${filename}-${outputLine}`;
        outputLines.push(outputLine);
      }
    }

    // The matching line
    if (!printedLines.has(lineNum)) {
      printedLines.add(lineNum);
      lastPrintedLine = lineNum;
      const line = lines[lineNum];

      if (onlyMatching) {
        regex.lastIndex = 0;
        for (
          let match = regex.exec(line);
          match !== null;
          match = regex.exec(line)
        ) {
          // If \K was used, extract from the capture group instead of full match
          const rawMatch =
            kResetGroup !== undefined ? (match[kResetGroup] ?? "") : match[0];
          const matchText = replace !== null ? replace : rawMatch;
          let prefix = filename ? `${filename}:` : "";
          if (showLineNumbers) prefix += `${lineNum + 1}:`;
          if (showColumn) prefix += `${match.index + 1}:`;
          outputLines.push(prefix + matchText);
          if (match[0].length === 0) regex.lastIndex++;
        }
      } else {
        let outputLine = line;
        if (showLineNumbers) outputLine = `${lineNum + 1}:${outputLine}`;
        if (filename) outputLine = `${filename}:${outputLine}`;
        outputLines.push(outputLine);
      }
    }

    // After context
    const maxAfter = Math.min(lastIdx - 1, lineNum + afterContext);
    for (let i = lineNum + 1; i <= maxAfter; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let outputLine = lines[i];
        if (showLineNumbers) outputLine = `${i + 1}-${outputLine}`;
        if (filename) outputLine = `${filename}-${outputLine}`;
        outputLines.push(outputLine);
      }
    }
  }

  return {
    output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
    matched: matchCount > 0,
    matchCount
  };
}

/**
 * Multiline search - searches entire content as one string
 * Patterns can match across line boundaries (e.g., 'foo\nbar')
 */
function searchContentMultiline(
  content: string,
  regex: UserRegex,
  options: {
    invertMatch: boolean;
    showLineNumbers: boolean;
    countOnly: boolean;
    countMatches: boolean;
    filename: string;
    onlyMatching: boolean;
    beforeContext: number;
    afterContext: number;
    maxCount: number;
    contextSeparator: string;
    showColumn: boolean;
    showByteOffset: boolean;
    replace: string | null;
    kResetGroup?: number;
  }
): SearchResult {
  const {
    invertMatch,
    showLineNumbers,
    countOnly,
    countMatches,
    filename,
    onlyMatching,
    beforeContext,
    afterContext,
    maxCount,
    contextSeparator,
    showColumn,
    showByteOffset,
    replace,
    kResetGroup
  } = options;

  const lines = content.split("\n");
  const lineCount = lines.length;
  const lastIdx =
    lineCount > 0 && lines[lineCount - 1] === "" ? lineCount - 1 : lineCount;

  // Build line offset map: lineOffsets[i] = byte offset where line i starts
  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lineOffsets.push(i + 1);
    }
  }

  // Helper: convert byte offset to line number (0-indexed)
  const getLineIndex = (byteOffset: number): number => {
    let line = 0;
    for (let i = 0; i < lineOffsets.length; i++) {
      if (lineOffsets[i] > byteOffset) break;
      line = i;
    }
    return line;
  };

  // Helper: get column within line (1-indexed)
  const getColumn = (byteOffset: number): number => {
    const lineIdx = getLineIndex(byteOffset);
    return byteOffset - lineOffsets[lineIdx] + 1;
  };

  // First pass: find all match spans
  const matchSpans: Array<{
    startLine: number;
    endLine: number;
    byteOffset: number;
    column: number;
    matchText: string;
  }> = [];

  regex.lastIndex = 0;
  for (
    let match = regex.exec(content);
    match !== null;
    match = regex.exec(content)
  ) {
    if (maxCount > 0 && matchSpans.length >= maxCount) break;

    const startLine = getLineIndex(match.index);
    const endLine = getLineIndex(
      match.index + Math.max(0, match[0].length - 1)
    );
    // If \K was used, extract from the capture group instead of full match
    const extractedMatch =
      kResetGroup !== undefined ? (match[kResetGroup] ?? "") : match[0];
    matchSpans.push({
      startLine,
      endLine,
      byteOffset: match.index,
      column: getColumn(match.index),
      matchText: extractedMatch
    });

    // Prevent infinite loop on zero-length matches
    if (match[0].length === 0) regex.lastIndex++;
  }

  // Count mode
  if (countOnly || countMatches) {
    let matchCount: number;
    if (countMatches) {
      // Count individual matches
      matchCount = invertMatch ? 0 : matchSpans.length;
    } else {
      // Count lines touched by matches
      const matchedLines = new Set<number>();
      for (const span of matchSpans) {
        for (let i = span.startLine; i <= span.endLine; i++) {
          matchedLines.add(i);
        }
      }
      matchCount = invertMatch
        ? lastIdx - matchedLines.size
        : matchedLines.size;
    }
    const countStr = filename
      ? `${filename}:${matchCount}`
      : String(matchCount);
    return { output: `${countStr}\n`, matched: matchCount > 0, matchCount };
  }

  // Inverted match: output lines not part of any match
  if (invertMatch) {
    const matchedLines = new Set<number>();
    for (const span of matchSpans) {
      for (let i = span.startLine; i <= span.endLine; i++) {
        matchedLines.add(i);
      }
    }

    const outputLines: string[] = [];
    for (let i = 0; i < lastIdx; i++) {
      if (!matchedLines.has(i)) {
        let line = lines[i];
        if (showLineNumbers) line = `${i + 1}:${line}`;
        if (filename) line = `${filename}:${line}`;
        outputLines.push(line);
      }
    }

    return {
      output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
      matched: outputLines.length > 0,
      matchCount: outputLines.length
    };
  }

  // No matches found
  if (matchSpans.length === 0) {
    return { output: "", matched: false, matchCount: 0 };
  }

  // Output with context
  const printedLines = new Set<number>();
  let lastPrintedLine = -1;
  const outputLines: string[] = [];

  for (const span of matchSpans) {
    const contextStart = Math.max(0, span.startLine - beforeContext);
    const contextEnd = Math.min(lastIdx - 1, span.endLine + afterContext);

    // Add separator if there's a gap
    if (lastPrintedLine >= 0 && contextStart > lastPrintedLine + 1) {
      outputLines.push(contextSeparator);
    }

    // Before context
    for (let i = contextStart; i < span.startLine; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let line = lines[i];
        if (showLineNumbers) line = `${i + 1}-${line}`;
        if (filename) line = `${filename}-${line}`;
        outputLines.push(line);
      }
    }

    // Match lines
    if (onlyMatching) {
      // Output only the matched text
      const matchText = replace !== null ? replace : span.matchText;
      let prefix = filename ? `${filename}:` : "";
      if (showByteOffset) prefix += `${span.byteOffset}:`;
      if (showLineNumbers) prefix += `${span.startLine + 1}:`;
      if (showColumn) prefix += `${span.column}:`;
      outputLines.push(prefix + matchText);
      // Mark lines as printed to handle context correctly
      for (let i = span.startLine; i <= span.endLine; i++) {
        printedLines.add(i);
        lastPrintedLine = i;
      }
    } else {
      // Output full lines containing the match
      for (let i = span.startLine; i <= span.endLine && i < lastIdx; i++) {
        if (!printedLines.has(i)) {
          printedLines.add(i);
          lastPrintedLine = i;
          let line = lines[i];
          // Apply replacement if specified (for the first line of the match)
          if (replace !== null && i === span.startLine) {
            regex.lastIndex = 0;
            line = regex.replace(line, replace);
          }
          let prefix = filename ? `${filename}:` : "";
          if (showByteOffset && i === span.startLine)
            prefix += `${span.byteOffset}:`;
          if (showLineNumbers) prefix += `${i + 1}:`;
          if (showColumn && i === span.startLine) prefix += `${span.column}:`;
          outputLines.push(prefix + line);
        }
      }
    }

    // After context
    for (let i = span.endLine + 1; i <= contextEnd; i++) {
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let line = lines[i];
        if (showLineNumbers) line = `${i + 1}-${line}`;
        if (filename) line = `${filename}-${line}`;
        outputLines.push(line);
      }
    }
  }

  return {
    output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
    matched: true,
    matchCount: matchSpans.length
  };
}
