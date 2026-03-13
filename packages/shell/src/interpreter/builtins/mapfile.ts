/**
 * mapfile/readarray - Read lines from stdin into an array
 *
 * Usage: mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [array]
 *        readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [array]
 *
 * Options:
 *   -d delim   Use delim as line delimiter (default: newline)
 *   -n count   Read at most count lines (0 = all)
 *   -O origin  Start assigning at index origin (default: 0)
 *   -s count   Skip first count lines
 *   -t         Remove trailing delimiter from each line
 *   array      Array name (default: MAPFILE)
 */

import type { ExecResult } from "../../types";
import { clearArray } from "../helpers/array";
import { result } from "../helpers/result";
import type { InterpreterContext } from "../types";

export function handleMapfile(
  ctx: InterpreterContext,
  args: string[],
  stdin: string
): ExecResult {
  // Parse options
  let delimiter = "\n";
  let maxCount = 0; // 0 = unlimited
  let origin = 0;
  let skipCount = 0;
  let trimDelimiter = false;
  let arrayName = "MAPFILE";

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-d" && i + 1 < args.length) {
      // In bash, -d '' means use NUL byte as delimiter
      delimiter = args[i + 1] === "" ? "\0" : args[i + 1] || "\n";
      i += 2;
    } else if (arg === "-n" && i + 1 < args.length) {
      maxCount = Number.parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else if (arg === "-O" && i + 1 < args.length) {
      origin = Number.parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else if (arg === "-s" && i + 1 < args.length) {
      skipCount = Number.parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else if (arg === "-t") {
      trimDelimiter = true;
      i++;
    } else if (arg === "-u" || arg === "-C" || arg === "-c") {
      // Skip unsupported options that take arguments
      i += 2;
    } else if (!arg.startsWith("-")) {
      arrayName = arg;
      i++;
    } else {
      // Unknown option, skip
      i++;
    }
  }

  // Use stdin from parameter, or fall back to groupStdin
  let effectiveStdin = stdin;
  if (!effectiveStdin && ctx.state.groupStdin !== undefined) {
    effectiveStdin = ctx.state.groupStdin;
  }

  // Split input by delimiter
  const lines: string[] = [];
  let remaining = effectiveStdin;
  let lineCount = 0;
  let skipped = 0;
  const maxArrayElements = ctx.limits?.maxArrayElements ?? 100000;

  while (remaining.length > 0) {
    const delimIndex = remaining.indexOf(delimiter);

    if (delimIndex === -1) {
      // No more delimiters, add remaining content as last line (if not empty)
      if (remaining.length > 0) {
        if (skipped < skipCount) {
          skipped++;
        } else if (maxCount === 0 || lineCount < maxCount) {
          // Check array element limit
          if (origin + lineCount >= maxArrayElements) {
            return result(
              "",
              `mapfile: array element limit exceeded (${maxArrayElements})\n`,
              1
            );
          }
          // Bash truncates at NUL bytes
          let lastLine = remaining;
          const nulIdx = lastLine.indexOf("\0");
          if (nulIdx !== -1) {
            lastLine = lastLine.substring(0, nulIdx);
          }
          lines.push(lastLine);
          lineCount++;
        }
      }
      break;
    }

    // Found delimiter
    let line = remaining.substring(0, delimIndex);
    // Bash truncates lines at NUL bytes (unlike 'read' which ignores them)
    const nulIndex = line.indexOf("\0");
    if (nulIndex !== -1) {
      line = line.substring(0, nulIndex);
    }
    // For other delimiters, include unless -t flag is set
    if (!trimDelimiter && delimiter !== "\0") {
      line += delimiter;
    }

    remaining = remaining.substring(delimIndex + delimiter.length);

    if (skipped < skipCount) {
      skipped++;
      continue;
    }

    if (maxCount > 0 && lineCount >= maxCount) {
      break;
    }

    // Check array element limit
    if (origin + lineCount >= maxArrayElements) {
      return result(
        "",
        `mapfile: array element limit exceeded (${maxArrayElements})\n`,
        1
      );
    }

    lines.push(line);
    lineCount++;
  }

  // Clear existing array ONLY if not using -O (offset) option
  // When using -O, we want to preserve existing elements and append starting at origin
  if (origin === 0) {
    clearArray(ctx, arrayName);
  }

  for (let j = 0; j < lines.length; j++) {
    ctx.state.env.set(`${arrayName}_${origin + j}`, lines[j]);
  }

  // Set array length metadata to be the max of existing length and new end position
  const existingLength = parseInt(
    ctx.state.env.get(`${arrayName}__length`) || "0",
    10
  );
  const newEndIndex = origin + lines.length;
  ctx.state.env.set(
    `${arrayName}__length`,
    String(Math.max(existingLength, newEndIndex))
  );

  // Consume from groupStdin if we used it
  if (ctx.state.groupStdin !== undefined && !stdin) {
    ctx.state.groupStdin = "";
  }

  return result("", "", 0);
}
