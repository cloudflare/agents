// Executor for sed commands

import { ExecutionLimitError } from "../../interpreter/errors";
import { createUserRegex } from "../../regex/index";
import { breToEre, escapeForList, normalizeForJs } from "./sed-regex";
import type {
  AddressRange,
  BranchCommand,
  BranchOnNoSubstCommand,
  BranchOnSubstCommand,
  GroupCommand,
  SedAddress,
  SedCommand,
  SedExecutionLimits,
  SedState,
  StepAddress,
  SubstituteCommand,
  TransliterateCommand
} from "./types";

const DEFAULT_MAX_ITERATIONS = 10000;

export function createInitialState(
  totalLines: number,
  filename?: string,
  rangeStates?: Map<string, import("./types.js").RangeState>
): SedState {
  return {
    patternSpace: "",
    holdSpace: "",
    lineNumber: 0,
    totalLines,
    deleted: false,
    printed: false,
    quit: false,
    quitSilent: false,
    exitCode: undefined,
    errorMessage: undefined,
    appendBuffer: [],
    substitutionMade: false,
    lineNumberOutput: [],
    nCommandOutput: [],
    restartCycle: false,
    inDRestartedCycle: false,
    currentFilename: filename,
    pendingFileReads: [],
    pendingFileWrites: [],
    rangeStates: rangeStates || new Map(),
    linesConsumedInCycle: 0
  };
}

function isStepAddress(address: SedAddress): address is StepAddress {
  return typeof address === "object" && "first" in address && "step" in address;
}

function isRelativeOffset(
  address: SedAddress
): address is import("./types.js").RelativeOffset {
  return typeof address === "object" && "offset" in address;
}

function matchesAddress(
  address: SedAddress,
  lineNum: number,
  totalLines: number,
  line: string,
  state?: SedState
): boolean {
  if (address === "$") {
    return lineNum === totalLines;
  }
  if (typeof address === "number") {
    return lineNum === address;
  }
  // Step address: first~step (e.g., 0~2 matches lines 0, 2, 4, ...)
  if (isStepAddress(address)) {
    const { first, step } = address;
    if (step === 0) return lineNum === first;
    return (lineNum - first) % step === 0 && lineNum >= first;
  }
  if (typeof address === "object" && "pattern" in address) {
    try {
      // Handle empty pattern (reuse last pattern)
      let rawPattern = address.pattern;
      if (rawPattern === "" && state?.lastPattern) {
        rawPattern = state.lastPattern;
      } else if (rawPattern !== "" && state) {
        // Track this pattern for future empty regex reuse
        state.lastPattern = rawPattern;
      }
      // Convert BRE to ERE for JavaScript regex compatibility
      // Then normalize for JavaScript (e.g., {,n} → {0,n})
      const pattern = normalizeForJs(breToEre(rawPattern));
      const regex = createUserRegex(pattern);
      return regex.test(line);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Serialize an address range to a string for use as a map key.
 */
function serializeRange(range: AddressRange): string {
  const serializeAddr = (addr: SedAddress | undefined): string => {
    if (addr === undefined) return "undefined";
    if (addr === "$") return "$";
    if (typeof addr === "number") return String(addr);
    if ("pattern" in addr) return `/${addr.pattern}/`;
    if ("first" in addr) return `${addr.first}~${addr.step}`;
    return "unknown";
  };
  return `${serializeAddr(range.start)},${serializeAddr(range.end)}`;
}

function isInRangeInternal(
  range: AddressRange | undefined,
  lineNum: number,
  totalLines: number,
  line: string,
  rangeStates?: Map<string, import("./types.js").RangeState>,
  state?: SedState
): boolean {
  if (!range || (!range.start && !range.end)) {
    return true; // No address means match all lines
  }

  const start = range.start;
  const end = range.end;

  if (start !== undefined && end === undefined) {
    // Single address
    return matchesAddress(start, lineNum, totalLines, line, state);
  }

  if (start !== undefined && end !== undefined) {
    // Address range - needs state tracking for pattern addresses
    const hasPatternStart = typeof start === "object" && "pattern" in start;
    const hasPatternEnd = typeof end === "object" && "pattern" in end;
    const hasRelativeEnd = isRelativeOffset(end);

    // Handle relative offset end address (GNU extension: /pattern/,+N)
    if (hasRelativeEnd && rangeStates) {
      const rangeKey = serializeRange(range);
      let rangeState = rangeStates.get(rangeKey);

      if (!rangeState) {
        rangeState = { active: false };
        rangeStates.set(rangeKey, rangeState);
      }

      if (!rangeState.active) {
        // Not in range yet - check if start matches
        // For relative offset ranges, allow restarting (don't check completed)
        const startMatches = matchesAddress(
          start,
          lineNum,
          totalLines,
          line,
          state
        );

        if (startMatches) {
          rangeState.active = true;
          rangeState.startLine = lineNum;
          rangeStates.set(rangeKey, rangeState);

          // Check if offset is 0 (match only the start line)
          if (end.offset === 0) {
            rangeState.active = false;
            rangeStates.set(rangeKey, rangeState);
          }
          return true;
        }
        return false;
      } else {
        // Already in range - check if we've matched enough lines
        const startLine = rangeState.startLine || lineNum;
        if (lineNum >= startLine + end.offset) {
          // This is the last line in the range
          rangeState.active = false;
          rangeStates.set(rangeKey, rangeState);
        }
        return true;
      }
    }

    // If both are numeric, check for backward range (need state tracking)
    if (!hasPatternStart && !hasPatternEnd && !hasRelativeEnd) {
      const startNum =
        typeof start === "number" ? start : start === "$" ? totalLines : 1;
      const endNum =
        typeof end === "number" ? end : end === "$" ? totalLines : totalLines;

      // For forward ranges (start <= end), use simple check
      if (startNum <= endNum) {
        return lineNum >= startNum && lineNum <= endNum;
      }

      // For backward ranges (start > end), use state tracking
      // GNU sed behavior: match only when start is first reached/passed
      if (rangeStates) {
        const rangeKey = serializeRange(range);
        let rangeState = rangeStates.get(rangeKey);

        if (!rangeState) {
          rangeState = { active: false };
          rangeStates.set(rangeKey, rangeState);
        }

        if (!rangeState.completed) {
          if (lineNum >= startNum) {
            rangeState.completed = true;
            rangeStates.set(rangeKey, rangeState);
            return true;
          }
        }
        return false;
      }

      // Fallback: no state tracking available, can't handle backward range
      return false;
    }

    // For pattern ranges, use state tracking
    if (rangeStates) {
      const rangeKey = serializeRange(range);
      let rangeState = rangeStates.get(rangeKey);

      if (!rangeState) {
        rangeState = { active: false };
        rangeStates.set(rangeKey, rangeState);
      }

      if (!rangeState.active) {
        // Not in range yet - check if start matches
        // For numeric start addresses, GNU sed activates the range if lineNum >= start
        // (this handles the case where line N was deleted before this command was reached)
        // But don't reactivate if the range was already completed
        if (rangeState.completed) {
          return false;
        }

        let startMatches = false;
        if (typeof start === "number") {
          startMatches = lineNum >= start;
        } else {
          startMatches = matchesAddress(
            start,
            lineNum,
            totalLines,
            line,
            state
          );
        }

        if (startMatches) {
          rangeState.active = true;
          rangeState.startLine = lineNum;
          rangeStates.set(rangeKey, rangeState);

          // Check if end also matches on the same line
          if (matchesAddress(end, lineNum, totalLines, line, state)) {
            rangeState.active = false;
            // Mark as completed for numeric start ranges
            if (typeof start === "number") {
              rangeState.completed = true;
            }
            rangeStates.set(rangeKey, rangeState);
          }
          return true;
        }
        return false;
      } else {
        // Already in range - check if end matches
        if (matchesAddress(end, lineNum, totalLines, line, state)) {
          rangeState.active = false;
          // Mark as completed for numeric start ranges
          if (typeof start === "number") {
            rangeState.completed = true;
          }
          rangeStates.set(rangeKey, rangeState);
        }
        return true;
      }
    }

    // Fallback for no range state tracking (shouldn't happen)
    const startMatches = matchesAddress(
      start,
      lineNum,
      totalLines,
      line,
      state
    );
    return startMatches;
  }

  return true;
}

function isInRange(
  range: AddressRange | undefined,
  lineNum: number,
  totalLines: number,
  line: string,
  rangeStates?: Map<string, import("./types.js").RangeState>,
  state?: SedState
): boolean {
  const result = isInRangeInternal(
    range,
    lineNum,
    totalLines,
    line,
    rangeStates,
    state
  );

  // Handle negation modifier
  if (range?.negated) {
    return !result;
  }

  return result;
}

/**
 * Custom global replacement function that handles zero-length matches correctly.
 * POSIX sed behavior:
 * 1. After a zero-length match: replace, then advance by 1 char, output that char
 * 2. After a non-zero-length match: if next position would be a zero-length match, skip it
 */
function globalReplace(
  input: string,
  regex: import("../../regex/index.js").UserRegex,
  _replacement: string,
  replaceFn: (match: string, groups: string[]) => string
): string {
  let result = "";
  let pos = 0;
  let skipZeroLengthAtNextPos = false;

  while (pos <= input.length) {
    // Reset lastIndex to current position
    regex.lastIndex = pos;

    const match = regex.exec(input);

    // No match found at or after current position
    if (!match) {
      // Output remaining characters
      result += input.slice(pos);
      break;
    }

    // Match found, but not at current position
    if (match.index !== pos) {
      // Output characters up to the match
      result += input.slice(pos, match.index);
      pos = match.index;
      skipZeroLengthAtNextPos = false;
      continue;
    }

    // Match found at current position
    const matchedText = match[0];
    const groups = match.slice(1);

    // After a non-zero match, skip zero-length matches at the boundary
    if (skipZeroLengthAtNextPos && matchedText.length === 0) {
      // Skip this zero-length match, output the character, advance
      if (pos < input.length) {
        result += input[pos];
        pos++;
      } else {
        break;
      }
      skipZeroLengthAtNextPos = false;
      continue;
    }

    // Apply replacement
    result += replaceFn(matchedText, groups);
    skipZeroLengthAtNextPos = false;

    if (matchedText.length === 0) {
      // Zero-length match: advance by 1 char, output that char
      if (pos < input.length) {
        result += input[pos];
        pos++;
      } else {
        break; // At end of string
      }
    } else {
      // Non-zero-length match: advance by match length
      // Set flag to skip zero-length match at next position
      pos += matchedText.length;
      skipZeroLengthAtNextPos = true;
    }
  }

  return result;
}

function processReplacement(
  replacement: string,
  match: string,
  groups: string[]
): string {
  let result = "";
  let i = 0;

  while (i < replacement.length) {
    if (replacement[i] === "\\") {
      if (i + 1 < replacement.length) {
        const next = replacement[i + 1];
        if (next === "&") {
          result += "&";
          i += 2;
          continue;
        }
        if (next === "n") {
          result += "\n";
          i += 2;
          continue;
        }
        if (next === "t") {
          result += "\t";
          i += 2;
          continue;
        }
        if (next === "r") {
          result += "\r";
          i += 2;
          continue;
        }
        // Back-references \0 through \9
        // \0 is the entire match (same as &)
        const digit = parseInt(next, 10);
        if (digit === 0) {
          result += match;
          i += 2;
          continue;
        }
        if (digit >= 1 && digit <= 9) {
          result += groups[digit - 1] || "";
          i += 2;
          continue;
        }
        // Other escaped characters
        result += next;
        i += 2;
        continue;
      }
    }

    if (replacement[i] === "&") {
      result += match;
      i++;
      continue;
    }

    result += replacement[i];
    i++;
  }

  return result;
}

function checkSpaceSize(
  space: string,
  maxLen: number,
  spaceName: string
): void {
  if (maxLen > 0 && space.length > maxLen) {
    throw new ExecutionLimitError(
      `sed: ${spaceName} size limit exceeded (${maxLen} bytes)`,
      "string_length"
    );
  }
}

function executeCommand(
  cmd: SedCommand,
  state: SedState,
  limits?: SedExecutionLimits
): void {
  const { lineNumber, totalLines, patternSpace } = state;

  // Labels don't have addresses and are handled separately
  if (cmd.type === "label") {
    return;
  }

  // Check if command applies to current line
  if (
    !isInRange(
      cmd.address,
      lineNumber,
      totalLines,
      patternSpace,
      state.rangeStates,
      state
    )
  ) {
    return;
  }

  switch (cmd.type) {
    case "substitute": {
      const subCmd = cmd as SubstituteCommand;
      let flags = "";
      if (subCmd.global) flags += "g";
      if (subCmd.ignoreCase) flags += "i";

      // Handle empty pattern (reuse last pattern)
      let rawPattern = subCmd.pattern;
      if (rawPattern === "" && state.lastPattern) {
        rawPattern = state.lastPattern;
      } else if (rawPattern !== "") {
        // Track this pattern for future empty regex reuse
        state.lastPattern = rawPattern;
      }

      // Convert BRE to ERE if not using extended regex mode
      // BRE: +, ?, |, (, ) are literal; \+, \?, \|, \(, \) are special
      // ERE (JavaScript): +, ?, |, (, ) are special
      // Then normalize for JavaScript (e.g., {,n} → {0,n})
      const pattern = normalizeForJs(
        subCmd.extendedRegex ? rawPattern : breToEre(rawPattern)
      );

      try {
        const regex = createUserRegex(pattern, flags);

        // Check if pattern matches FIRST - for t/T command tracking
        // t should branch if substitution matched, even if replacement is same as original
        const hasMatch = regex.test(state.patternSpace);
        // Reset lastIndex after test() for global regex
        regex.lastIndex = 0;

        if (hasMatch) {
          // Mark substitution as successful BEFORE replacement (for t/T commands)
          state.substitutionMade = true;

          // Handle Nth occurrence
          if (
            subCmd.nthOccurrence &&
            subCmd.nthOccurrence > 0 &&
            !subCmd.global
          ) {
            let count = 0;
            const nth = subCmd.nthOccurrence;
            const nthRegex = createUserRegex(
              pattern,
              `g${subCmd.ignoreCase ? "i" : ""}`
            );
            state.patternSpace = nthRegex.replace(
              state.patternSpace,
              (match, ...args) => {
                count++;
                if (count === nth) {
                  const groups = args.slice(0, -2) as string[];
                  return processReplacement(subCmd.replacement, match, groups);
                }
                return match;
              }
            );
          } else if (subCmd.global) {
            // Use custom global replace for POSIX-compliant zero-length match handling
            const globalRegex = createUserRegex(
              pattern,
              `g${subCmd.ignoreCase ? "i" : ""}`
            );
            state.patternSpace = globalReplace(
              state.patternSpace,
              globalRegex,
              subCmd.replacement,
              (match, groups) =>
                processReplacement(subCmd.replacement, match, groups)
            );
          } else {
            state.patternSpace = regex.replace(
              state.patternSpace,
              (match, ...args) => {
                // Extract captured groups (all args before the last two which are offset and string)
                const groups = args.slice(0, -2) as string[];
                return processReplacement(subCmd.replacement, match, groups);
              }
            );
          }

          if (subCmd.printOnMatch) {
            // p flag - immediately print pattern space after substitution
            state.lineNumberOutput.push(state.patternSpace);
          }
        }
      } catch {
        // Invalid regex, skip
      }
      break;
    }

    case "print":
      // p - immediately print pattern space
      state.lineNumberOutput.push(state.patternSpace);
      break;

    case "printFirstLine": {
      // P - print up to first newline
      const newlineIdx = state.patternSpace.indexOf("\n");
      if (newlineIdx !== -1) {
        state.lineNumberOutput.push(state.patternSpace.slice(0, newlineIdx));
      } else {
        state.lineNumberOutput.push(state.patternSpace);
      }
      break;
    }

    case "delete":
      state.deleted = true;
      break;

    case "deleteFirstLine": {
      // D - delete up to first newline, restart cycle if more content
      const newlineIdx = state.patternSpace.indexOf("\n");
      if (newlineIdx !== -1) {
        state.patternSpace = state.patternSpace.slice(newlineIdx + 1);
        // Restart the cycle from the beginning with remaining content
        state.restartCycle = true;
        state.inDRestartedCycle = true;
      } else {
        state.deleted = true;
      }
      break;
    }

    case "zap":
      // z - empty pattern space (GNU extension)
      state.patternSpace = "";
      break;

    case "append":
      state.appendBuffer.push(cmd.text);
      break;

    case "insert":
      // Insert happens before the current line
      // We'll handle this in the main loop by prepending
      state.appendBuffer.unshift(`__INSERT__${cmd.text}`);
      break;

    case "change":
      // Replace the current line entirely - text is output in place of pattern space
      state.deleted = true; // Don't print original pattern space
      state.changedText = cmd.text; // Output this in place of pattern space
      break;

    case "hold":
      // h - Copy pattern space to hold space
      state.holdSpace = state.patternSpace;
      break;

    case "holdAppend":
      // H - Append pattern space to hold space (with newline)
      if (state.holdSpace) {
        state.holdSpace += `\n${state.patternSpace}`;
      } else {
        state.holdSpace = state.patternSpace;
      }
      checkSpaceSize(
        state.holdSpace,
        limits?.maxStringLength ?? 0,
        "hold space"
      );
      break;

    case "get":
      // g - Copy hold space to pattern space
      state.patternSpace = state.holdSpace;
      break;

    case "getAppend":
      // G - Append hold space to pattern space (with newline)
      state.patternSpace += `\n${state.holdSpace}`;
      checkSpaceSize(
        state.patternSpace,
        limits?.maxStringLength ?? 0,
        "pattern space"
      );
      break;

    case "exchange": {
      // x - Exchange pattern and hold spaces
      const temp = state.patternSpace;
      state.patternSpace = state.holdSpace;
      state.holdSpace = temp;
      break;
    }

    case "next":
      // n - Print pattern space (if not in quiet mode), read next line
      // This will be handled in the main loop
      state.printed = true;
      break;

    case "quit":
      state.quit = true;
      if (cmd.exitCode !== undefined) {
        state.exitCode = cmd.exitCode;
      }
      break;

    case "quitSilent":
      // Q - quit without printing pattern space
      state.quit = true;
      state.quitSilent = true;
      if (cmd.exitCode !== undefined) {
        state.exitCode = cmd.exitCode;
      }
      break;

    case "list": {
      // l - list pattern space with escapes
      const escaped = escapeForList(state.patternSpace);
      state.lineNumberOutput.push(escaped);
      break;
    }

    case "printFilename":
      // F - print current filename
      if (state.currentFilename) {
        state.lineNumberOutput.push(state.currentFilename);
      }
      break;

    case "version": {
      // v - version check
      // We claim to be GNU sed 4.8
      const OUR_VERSION = [4, 8, 0];

      if (cmd.minVersion) {
        // Parse version string (e.g., "4.5.3" or "4.5")
        const parts = cmd.minVersion.split(".");
        const requestedVersion: number[] = [];
        let parseError = false;

        for (const part of parts) {
          const num = parseInt(part, 10);
          if (Number.isNaN(num) || num < 0) {
            // Invalid version format
            state.quit = true;
            state.exitCode = 1;
            state.errorMessage = `sed: invalid version string: ${cmd.minVersion}`;
            parseError = true;
            break;
          }
          requestedVersion.push(num);
        }

        if (!parseError) {
          // Pad to 3 parts for comparison
          while (requestedVersion.length < 3) {
            requestedVersion.push(0);
          }

          // Compare versions
          for (let i = 0; i < 3; i++) {
            if (requestedVersion[i] > OUR_VERSION[i]) {
              // Requested version is newer than ours
              state.quit = true;
              state.exitCode = 1;
              state.errorMessage = `sed: this is not GNU sed version ${cmd.minVersion}`;
              break;
            }
            if (requestedVersion[i] < OUR_VERSION[i]) {
              // Our version is newer, we're good
              break;
            }
          }
        }
      }
      break;
    }

    case "readFile":
      // r - queue file read (deferred execution)
      state.pendingFileReads.push({ filename: cmd.filename, wholeFile: true });
      break;

    case "readFileLine":
      // R - queue single line file read (deferred execution)
      state.pendingFileReads.push({ filename: cmd.filename, wholeFile: false });
      break;

    case "writeFile":
      // w - queue file write (deferred execution)
      state.pendingFileWrites.push({
        filename: cmd.filename,
        content: `${state.patternSpace}\n`
      });
      break;

    case "writeFirstLine": {
      // W - queue first line file write (deferred execution)
      const newlineIdx = state.patternSpace.indexOf("\n");
      const firstLine =
        newlineIdx !== -1
          ? state.patternSpace.slice(0, newlineIdx)
          : state.patternSpace;
      state.pendingFileWrites.push({
        filename: cmd.filename,
        content: `${firstLine}\n`
      });
      break;
    }

    case "execute":
      // SECURITY: sed 'e' command (execute shell command) is intentionally
      // blocked in sandboxed environment. Same rationale as AWK system().
      state.errorMessage =
        "sed: e command (shell execution) is not supported in sandboxed environment";
      state.quit = true;
      break;

    case "transliterate":
      // y/source/dest/ - Transliterate characters
      state.patternSpace = executeTransliterate(
        state.patternSpace,
        cmd as TransliterateCommand
      );
      break;

    case "lineNumber":
      // = - Print line number
      state.lineNumberOutput.push(String(state.lineNumber));
      break;

    case "branch":
      // b [label] - Will be handled in executeCommands
      break;

    case "branchOnSubst":
      // t [label] - Will be handled in executeCommands
      break;

    case "branchOnNoSubst":
      // T [label] - Will be handled in executeCommands
      break;

    case "group":
      // Grouped commands - will be handled in executeCommands
      break;
  }
}

function executeTransliterate(
  input: string,
  cmd: TransliterateCommand
): string {
  let result = "";
  for (const char of input) {
    const idx = cmd.source.indexOf(char);
    if (idx !== -1) {
      result += cmd.dest[idx];
    } else {
      result += char;
    }
  }
  return result;
}

export interface ExecuteContext {
  lines: string[];
  currentLineIndex: number;
}

export function executeCommands(
  commands: SedCommand[],
  state: SedState,
  ctx?: ExecuteContext,
  limits?: SedExecutionLimits
): number {
  // Build label index for branching
  const labelIndex = new Map<string, number>();
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (cmd.type === "label") {
      labelIndex.set(cmd.name, i);
    }
  }

  const maxIterations = limits?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let totalIterations = 0;

  let i = 0;
  while (i < commands.length) {
    totalIterations++;
    if (totalIterations > maxIterations) {
      throw new ExecutionLimitError(
        `sed: command execution exceeded maximum iterations (${maxIterations})`,
        "iterations"
      );
    }

    if (state.deleted || state.quit || state.quitSilent || state.restartCycle)
      break;

    const cmd = commands[i];

    // Handle n command specially - it needs to print and read next line inline
    if (cmd.type === "next") {
      if (
        isInRange(
          cmd.address,
          state.lineNumber,
          state.totalLines,
          state.patternSpace,
          state.rangeStates,
          state
        )
      ) {
        // Output current pattern space (will be handled by caller based on silent mode)
        // nCommandOutput respects silent mode - won't print if -n is set
        state.nCommandOutput.push(state.patternSpace);
        // Don't set state.printed = true here, as that would trigger silent mode print
        // The nCommandOutput mechanism handles the output properly

        if (
          ctx &&
          ctx.currentLineIndex + state.linesConsumedInCycle + 1 <
            ctx.lines.length
        ) {
          state.linesConsumedInCycle++;
          const nextLine =
            ctx.lines[ctx.currentLineIndex + state.linesConsumedInCycle];
          state.patternSpace = nextLine;
          state.lineNumber =
            ctx.currentLineIndex + state.linesConsumedInCycle + 1;
          // Reset substitution flag for new line (for t/T commands)
          state.substitutionMade = false;
        } else {
          // If no next line, n quits after printing
          // Mark as deleted to prevent auto-print of the pattern space
          // (we already printed it via lineNumberOutput)
          state.quit = true;
          state.deleted = true;
          break;
        }
      }
      i++;
      continue;
    }

    // Handle N command specially - it needs to append next line inline
    if (cmd.type === "nextAppend") {
      if (
        isInRange(
          cmd.address,
          state.lineNumber,
          state.totalLines,
          state.patternSpace,
          state.rangeStates,
          state
        )
      ) {
        if (
          ctx &&
          ctx.currentLineIndex + state.linesConsumedInCycle + 1 <
            ctx.lines.length
        ) {
          state.linesConsumedInCycle++;
          const nextLine =
            ctx.lines[ctx.currentLineIndex + state.linesConsumedInCycle];
          state.patternSpace += `\n${nextLine}`;
          state.lineNumber =
            ctx.currentLineIndex + state.linesConsumedInCycle + 1;
        } else {
          // If no next line, N quits but auto-print happens first
          state.quit = true;
          // Let auto-print happen - GNU sed prints pattern space when N fails
          break;
        }
      }
      i++;
      continue;
    }

    // Handle branching commands specially
    if (cmd.type === "branch") {
      const branchCmd = cmd as BranchCommand;
      // Check if address matches
      if (
        isInRange(
          branchCmd.address,
          state.lineNumber,
          state.totalLines,
          state.patternSpace,
          state.rangeStates,
          state
        )
      ) {
        if (branchCmd.label) {
          const target = labelIndex.get(branchCmd.label);
          if (target !== undefined) {
            i = target;
            continue;
          }
          // Label not found in current scope - request outer scope to handle it
          state.branchRequest = branchCmd.label;
          break;
        }
        // Branch without label means jump to end
        break;
      }
      i++;
      continue;
    }

    if (cmd.type === "branchOnSubst") {
      const branchCmd = cmd as BranchOnSubstCommand;
      // Check if address matches
      if (
        isInRange(
          branchCmd.address,
          state.lineNumber,
          state.totalLines,
          state.patternSpace,
          state.rangeStates,
          state
        )
      ) {
        if (state.substitutionMade) {
          state.substitutionMade = false; // Reset flag
          if (branchCmd.label) {
            const target = labelIndex.get(branchCmd.label);
            if (target !== undefined) {
              i = target;
              continue;
            }
            // Label not found in current scope - request outer scope to handle it
            state.branchRequest = branchCmd.label;
            break;
          }
          // Branch without label means jump to end
          break;
        }
      }
      i++;
      continue;
    }

    // T - branch if NO substitution made (since last line read)
    if (cmd.type === "branchOnNoSubst") {
      const branchCmd = cmd as BranchOnNoSubstCommand;
      // Check if address matches
      if (
        isInRange(
          branchCmd.address,
          state.lineNumber,
          state.totalLines,
          state.patternSpace,
          state.rangeStates,
          state
        )
      ) {
        if (!state.substitutionMade) {
          if (branchCmd.label) {
            const target = labelIndex.get(branchCmd.label);
            if (target !== undefined) {
              i = target;
              continue;
            }
            // Label not found in current scope - request outer scope to handle it
            state.branchRequest = branchCmd.label;
            break;
          }
          // Branch without label means jump to end
          break;
        }
      }
      i++;
      continue;
    }

    // Grouped commands - execute recursively
    if (cmd.type === "group") {
      const groupCmd = cmd as GroupCommand;
      if (
        isInRange(
          groupCmd.address,
          state.lineNumber,
          state.totalLines,
          state.patternSpace,
          state.rangeStates,
          state
        )
      ) {
        // Execute all commands in the group
        // Lines consumed are tracked in state.linesConsumedInCycle
        executeCommands(groupCmd.commands, state, ctx, limits);

        // Handle cross-group branch request from nested group
        if (state.branchRequest) {
          const target = labelIndex.get(state.branchRequest);
          if (target !== undefined) {
            // Found the label in this scope - execute the branch
            state.branchRequest = undefined;
            i = target;
            continue;
          }
          // Label not found in this scope either - propagate up
          break;
        }
      }
      i++;
      continue;
    }

    executeCommand(cmd, state, limits);
    i++;
  }

  return state.linesConsumedInCycle;
}
