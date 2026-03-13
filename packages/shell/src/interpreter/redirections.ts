/**
 * Redirection Handling
 *
 * Handles output redirections:
 * - > : Write stdout to file
 * - >> : Append stdout to file
 * - 2> : Write stderr to file
 * - &> : Write both stdout and stderr to file
 * - >& : Redirect fd to another fd
 * - {fd}>file : Allocate FD and store in variable
 */

import type { RedirectionNode, WordNode } from "../ast/types";
import type { ExecResult } from "../types";
import {
  expandRedirectTarget,
  expandWord,
  hasQuotedMultiValueAt
} from "./expansion";
import { checkFdLimit, result as makeResult } from "./helpers/result";
import type { InterpreterContext } from "./types";

/**
 * Check if a redirect target is valid for output (not a directory, respects noclobber).
 * Returns an error message string if invalid, null if valid.
 */
async function checkOutputRedirectTarget(
  ctx: InterpreterContext,
  filePath: string,
  target: string,
  options: { checkNoclobber?: boolean; isClobber?: boolean }
): Promise<string | null> {
  try {
    const stat = await ctx.fs.stat(filePath);
    if (stat.isDirectory) {
      return `bash: ${target}: Is a directory\n`;
    }
    if (
      options.checkNoclobber &&
      ctx.state.options.noclobber &&
      !options.isClobber &&
      target !== "/dev/null"
    ) {
      return `bash: ${target}: cannot overwrite existing file\n`;
    }
  } catch {
    // File doesn't exist, that's ok - we'll create it
  }
  return null;
}

/**
 * Determine the encoding to use for file I/O.
 * If all character codes are <= 127 (ASCII), use binary encoding (byte data).
 * Otherwise, use UTF-8 encoding (text with non-ASCII characters).
 * For performance, only check the first 8KB of large strings.
 *
 * Characters in the 128-255 range (e.g. Latin-1: Ü Ö Ä é è) need UTF-8
 * encoding because their multi-byte UTF-8 representation would be lost
 * if stored as single bytes via binary encoding.
 */
function getFileEncoding(content: string): "binary" | "utf8" {
  const SAMPLE_SIZE = 8192; // 8KB

  // For large strings, only check the first 8KB
  // This is sufficient since UTF-8 files typically have Unicode chars early
  const checkLength = Math.min(content.length, SAMPLE_SIZE);

  for (let i = 0; i < checkLength; i++) {
    if (content.charCodeAt(i) > 127) {
      return "utf8";
    }
  }
  return "binary";
}

/**
 * Parse the content of a read-write file descriptor.
 * Format: __rw__:pathLength:path:position:content
 * @returns The parsed components, or null if format is invalid
 */
function parseRwFdContent(fdContent: string): {
  path: string;
  position: number;
  content: string;
} | null {
  if (!fdContent.startsWith("__rw__:")) {
    return null;
  }
  const afterPrefix = fdContent.slice(7);
  const firstColonIdx = afterPrefix.indexOf(":");
  if (firstColonIdx === -1) return null;
  const pathLength = Number.parseInt(afterPrefix.slice(0, firstColonIdx), 10);
  if (Number.isNaN(pathLength) || pathLength < 0) return null;
  const pathStart = firstColonIdx + 1;
  const path = afterPrefix.slice(pathStart, pathStart + pathLength);
  const positionStart = pathStart + pathLength + 1;
  const remaining = afterPrefix.slice(positionStart);
  const posColonIdx = remaining.indexOf(":");
  if (posColonIdx === -1) return null;
  const position = Number.parseInt(remaining.slice(0, posColonIdx), 10);
  if (Number.isNaN(position) || position < 0) return null;
  const content = remaining.slice(posColonIdx + 1);
  return { path, position, content };
}

/**
 * Pre-expanded redirect targets, keyed by index into the redirections array.
 * This allows us to expand redirect targets (including side effects) before
 * executing a function body, then apply the redirections after.
 */
export type ExpandedRedirectTargets = Map<number, string>;

/**
 * Pre-expand redirect targets for function definitions.
 * This is needed because redirections on function definitions are evaluated
 * each time the function is called, and any side effects (like $((i++)))
 * must occur BEFORE the function body executes.
 */
export async function preExpandRedirectTargets(
  ctx: InterpreterContext,
  redirections: RedirectionNode[]
): Promise<{ targets: ExpandedRedirectTargets; error?: string }> {
  const targets: ExpandedRedirectTargets = new Map();

  for (let i = 0; i < redirections.length; i++) {
    const redir = redirections[i];
    if (redir.target.type === "HereDoc") {
      continue;
    }

    const isFdRedirect = redir.operator === ">&" || redir.operator === "<&";
    if (isFdRedirect) {
      // Check for "$@" with multiple positional params - this is an ambiguous redirect
      if (hasQuotedMultiValueAt(ctx, redir.target as WordNode)) {
        return { targets, error: "bash: $@: ambiguous redirect\n" };
      }
      targets.set(i, await expandWord(ctx, redir.target as WordNode));
    } else {
      const expandResult = await expandRedirectTarget(
        ctx,
        redir.target as WordNode
      );
      if ("error" in expandResult) {
        return { targets, error: expandResult.error };
      }
      targets.set(i, expandResult.target);
    }
  }

  return { targets };
}

/**
 * Allocate the next available file descriptor (starting at 10).
 * Returns the allocated FD number.
 */
function allocateFd(ctx: InterpreterContext): number {
  if (ctx.state.nextFd === undefined) {
    ctx.state.nextFd = 10;
  }
  const fd = ctx.state.nextFd;
  const maxFds = ctx.limits.maxFileDescriptors;
  if (fd >= maxFds) {
    throw new Error(
      `bash: cannot allocate file descriptor: too many open files (max ${maxFds})`
    );
  }
  ctx.state.nextFd++;
  return fd;
}

/**
 * Process FD variable redirections ({varname}>file syntax).
 * This allocates FDs and sets variables before command execution.
 * Returns an error result if there's an issue, or null if successful.
 */
export async function processFdVariableRedirections(
  ctx: InterpreterContext,
  redirections: RedirectionNode[]
): Promise<ExecResult | null> {
  for (const redir of redirections) {
    if (!redir.fdVariable) {
      continue;
    }

    // Initialize fileDescriptors map if needed
    if (!ctx.state.fileDescriptors) {
      ctx.state.fileDescriptors = new Map();
    }

    // Handle close operation: {fd}>&- or {fd}<&-
    // For close operations, we look up the existing variable value (the FD number)
    // and close that FD, rather than allocating a new one.
    if (
      (redir.operator === ">&" || redir.operator === "<&") &&
      redir.target.type === "Word"
    ) {
      const target = await expandWord(ctx, redir.target as WordNode);
      if (target === "-") {
        // Close operation - look up the FD from the variable and close it
        const existingFd = ctx.state.env.get(redir.fdVariable);
        if (existingFd !== undefined) {
          const fdNum = Number.parseInt(existingFd, 10);
          if (!Number.isNaN(fdNum)) {
            ctx.state.fileDescriptors.delete(fdNum);
          }
        }
        // Don't allocate a new FD for close operations
        continue;
      }
    }

    // Allocate a new FD (for non-close operations)
    const fd = allocateFd(ctx);

    // Set the variable to the allocated FD number
    ctx.state.env.set(redir.fdVariable, String(fd));

    // For file redirections, store the file path mapping
    if (redir.target.type === "Word") {
      const target = await expandWord(ctx, redir.target as WordNode);

      // Handle FD duplication: {fd}>&N or {fd}<&N
      if (redir.operator === ">&" || redir.operator === "<&") {
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd)) {
          // Duplicate the source FD's content to the new FD
          const content = ctx.state.fileDescriptors.get(sourceFd);
          if (content !== undefined) {
            checkFdLimit(ctx);
            ctx.state.fileDescriptors.set(fd, content);
          }
          continue;
        }
      }

      // For output redirections to files, we'll handle actual writing in applyRedirections
      // Store the target file path associated with this FD
      if (
        redir.operator === ">" ||
        redir.operator === ">>" ||
        redir.operator === ">|" ||
        redir.operator === "&>" ||
        redir.operator === "&>>"
      ) {
        // Mark this FD as pointing to a file (store file path for later use)
        // Use a special format to distinguish from content
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        // For truncating operators (>, >|, &>), create/truncate the file now
        if (
          redir.operator === ">" ||
          redir.operator === ">|" ||
          redir.operator === "&>"
        ) {
          await ctx.fs.writeFile(filePath, "", "binary");
        }
        checkFdLimit(ctx);
        ctx.state.fileDescriptors.set(fd, `__file__:${filePath}`);
      } else if (redir.operator === "<<<") {
        // For here-strings, store the target value plus newline as the FD content
        checkFdLimit(ctx);
        ctx.state.fileDescriptors.set(fd, `${target}\n`);
      } else if (redir.operator === "<" || redir.operator === "<>") {
        // For input redirections, read the file content
        try {
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const content = await ctx.fs.readFile(filePath);
          checkFdLimit(ctx);
          ctx.state.fileDescriptors.set(fd, content);
        } catch {
          return makeResult(
            "",
            `bash: ${target}: No such file or directory\n`,
            1
          );
        }
      }
    }
  }

  return null; // Success
}

/**
 * Pre-open (truncate) output redirect files before command execution.
 * This is needed for compound commands (subshell, for, case, [[) where
 * bash opens/truncates the redirect file BEFORE evaluating any words in
 * the command body (including command substitutions).
 *
 * Example: `(echo \`cat FILE\`) > FILE`
 * - Bash first truncates FILE (making it empty)
 * - Then executes the subshell, where `cat FILE` returns empty string
 *
 * Returns an error result if there's an issue (like directory or noclobber),
 * or null if pre-opening succeeded.
 */
export async function preOpenOutputRedirects(
  ctx: InterpreterContext,
  redirections: RedirectionNode[]
): Promise<ExecResult | null> {
  for (const redir of redirections) {
    if (redir.target.type === "HereDoc") {
      continue;
    }

    // Only handle output truncation redirects (>, >|, &>)
    // Append (>>, &>>) doesn't need pre-truncation
    // >&word needs special handling - it's a file redirect only if word is not a number
    const isGreaterAmpersand = redir.operator === ">&";
    if (
      redir.operator !== ">" &&
      redir.operator !== ">|" &&
      redir.operator !== "&>" &&
      !isGreaterAmpersand
    ) {
      continue;
    }

    // Expand redirect target with glob handling (failglob, ambiguous redirect)
    // For >&, use plain expansion first to check if it's a number
    let target: string;
    if (isGreaterAmpersand) {
      target = await expandWord(ctx, redir.target as WordNode);
      // If it's a number, -, or has explicit fd, it's an FD redirect, not a file redirect
      if (
        target === "-" ||
        !Number.isNaN(Number.parseInt(target, 10)) ||
        redir.fd != null
      ) {
        continue;
      }
      // It's a file redirect - re-expand with redirect target handling
      // (though we already have the expanded value, use it directly)
    } else {
      const expandResult = await expandRedirectTarget(
        ctx,
        redir.target as WordNode
      );
      if ("error" in expandResult) {
        return makeResult("", expandResult.error, 1);
      }
      target = expandResult.target;
    }
    const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
    const isClobber = redir.operator === ">|";

    // Reject paths containing null bytes - these cause filesystem errors
    // and are never valid in bash
    if (filePath.includes("\0")) {
      return makeResult("", `bash: ${target}: No such file or directory\n`, 1);
    }

    // Check if target is a directory or noclobber prevents overwrite
    try {
      const stat = await ctx.fs.stat(filePath);
      if (stat.isDirectory) {
        return makeResult("", `bash: ${target}: Is a directory\n`, 1);
      }
      // Check noclobber: if file exists and noclobber is set, refuse to overwrite
      // unless using >| (clobber operator) or writing to /dev/null
      if (
        ctx.state.options.noclobber &&
        !isClobber &&
        !stat.isDirectory &&
        target !== "/dev/null"
      ) {
        return makeResult(
          "",
          `bash: ${target}: cannot overwrite existing file\n`,
          1
        );
      }
    } catch {
      // File doesn't exist, that's ok - we'll create it
    }

    // Pre-truncate the file (create empty file)
    // This makes the file empty before any command substitutions in the
    // compound command body are evaluated
    // Skip special device files that don't need pre-truncation
    if (
      target !== "/dev/null" &&
      target !== "/dev/stdout" &&
      target !== "/dev/stderr" &&
      target !== "/dev/full"
    ) {
      await ctx.fs.writeFile(filePath, "", "binary");
    }

    // /dev/full always returns ENOSPC when written to
    if (target === "/dev/full") {
      return makeResult("", `bash: /dev/full: No space left on device\n`, 1);
    }
  }

  return null; // Success - no error
}

export async function applyRedirections(
  ctx: InterpreterContext,
  result: ExecResult,
  redirections: RedirectionNode[],
  preExpandedTargets?: ExpandedRedirectTargets
): Promise<ExecResult> {
  let { stdout, stderr, exitCode } = result;

  // Determine encoding for stdout writes:
  // - Commands that set stdoutEncoding: "binary" (e.g. cat, gzip) produce
  //   binary strings where each char represents a raw byte — use "binary"
  //   to preserve byte-level fidelity.
  // - Otherwise, use getFileEncoding which detects non-ASCII text and
  //   encodes it as UTF-8 so characters like Ü are stored correctly.
  const getStdoutEncoding =
    result.stdoutEncoding === "binary"
      ? () => "binary" as const
      : (content: string) => getFileEncoding(content);

  for (let i = 0; i < redirections.length; i++) {
    const redir = redirections[i];
    if (redir.target.type === "HereDoc") {
      continue;
    }

    // Use pre-expanded target if available, otherwise expand now
    let target: string;
    const preExpanded = preExpandedTargets?.get(i);
    if (preExpanded !== undefined) {
      target = preExpanded;
    } else {
      // For FD-to-FD redirects (>&), use plain expansion without glob handling
      // For file redirects, use glob expansion with failglob/ambiguous redirect handling
      const isFdRedirect = redir.operator === ">&" || redir.operator === "<&";
      if (isFdRedirect) {
        // Check for "$@" with multiple positional params - this is an ambiguous redirect
        if (hasQuotedMultiValueAt(ctx, redir.target as WordNode)) {
          stderr += "bash: $@: ambiguous redirect\n";
          exitCode = 1;
          stdout = "";
          continue;
        }
        target = await expandWord(ctx, redir.target as WordNode);
      } else {
        const expandResult = await expandRedirectTarget(
          ctx,
          redir.target as WordNode
        );
        if ("error" in expandResult) {
          stderr += expandResult.error;
          exitCode = 1;
          // When redirect fails, discard the output that would have been redirected
          stdout = "";
          continue;
        }
        target = expandResult.target;
      }
    }

    // Skip FD variable redirections in applyRedirections - they're already handled
    // by processFdVariableRedirections and don't affect stdout/stderr directly
    if (redir.fdVariable) {
      continue;
    }

    // Reject paths containing null bytes - these cause filesystem errors
    if (target.includes("\0")) {
      // oxlint-disable-next-line no-control-regex -- intentional null byte stripping
      stderr += `bash: ${target.replace(/\0/g, "")}: No such file or directory\n`;
      exitCode = 1;
      stdout = "";
      continue;
    }

    switch (redir.operator) {
      case ">":
      case ">|": {
        const fd = redir.fd ?? 1;
        const isClobber = redir.operator === ">|";
        if (fd === 1) {
          // /dev/stdout is a no-op for stdout - output stays on stdout
          if (target === "/dev/stdout") {
            break;
          }
          // /dev/stderr redirects stdout to stderr
          if (target === "/dev/stderr") {
            stderr += stdout;
            stdout = "";
            break;
          }
          // /dev/full always returns ENOSPC when written to
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device\n`;
            exitCode = 1;
            stdout = "";
            break;
          }
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const error = await checkOutputRedirectTarget(ctx, filePath, target, {
            checkNoclobber: true,
            isClobber
          });
          if (error) {
            stderr += error;
            exitCode = 1;
            stdout = "";
            break;
          }
          // Smart encoding: binary for byte data, UTF-8 for Unicode text
          await ctx.fs.writeFile(filePath, stdout, getStdoutEncoding(stdout));
          stdout = "";
        } else if (fd === 2) {
          // /dev/stderr is a no-op for stderr - output stays on stderr
          if (target === "/dev/stderr") {
            break;
          }
          // /dev/stdout redirects stderr to stdout
          if (target === "/dev/stdout") {
            stdout += stderr;
            stderr = "";
            break;
          }
          // /dev/full always returns ENOSPC when written to
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device\n`;
            exitCode = 1;
            break;
          }
          if (target === "/dev/null") {
            stderr = "";
          } else {
            const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
            const error = await checkOutputRedirectTarget(
              ctx,
              filePath,
              target,
              {
                checkNoclobber: true,
                isClobber
              }
            );
            if (error) {
              stderr += error;
              exitCode = 1;
              break;
            }
            // Smart encoding: binary for byte data, UTF-8 for Unicode text
            await ctx.fs.writeFile(filePath, stderr, getFileEncoding(stderr));
            stderr = "";
          }
        }
        break;
      }

      case ">>": {
        const fd = redir.fd ?? 1;
        if (fd === 1) {
          // /dev/stdout is a no-op for stdout - output stays on stdout
          if (target === "/dev/stdout") {
            break;
          }
          // /dev/stderr redirects stdout to stderr
          if (target === "/dev/stderr") {
            stderr += stdout;
            stdout = "";
            break;
          }
          // /dev/full always returns ENOSPC when written to
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device\n`;
            exitCode = 1;
            stdout = "";
            break;
          }
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const error = await checkOutputRedirectTarget(
            ctx,
            filePath,
            target,
            {}
          );
          if (error) {
            stderr += error;
            exitCode = 1;
            stdout = "";
            break;
          }
          // Smart encoding: binary for byte data, UTF-8 for Unicode text
          await ctx.fs.appendFile(filePath, stdout, getStdoutEncoding(stdout));
          stdout = "";
        } else if (fd === 2) {
          // /dev/stderr is a no-op for stderr - output stays on stderr
          if (target === "/dev/stderr") {
            break;
          }
          // /dev/stdout redirects stderr to stdout
          if (target === "/dev/stdout") {
            stdout += stderr;
            stderr = "";
            break;
          }
          // /dev/full always returns ENOSPC when written to
          if (target === "/dev/full") {
            stderr += `bash: echo: write error: No space left on device\n`;
            exitCode = 1;
            break;
          }
          const filePath2 = ctx.fs.resolvePath(ctx.state.cwd, target);
          const error2 = await checkOutputRedirectTarget(
            ctx,
            filePath2,
            target,
            {}
          );
          if (error2) {
            stderr += error2;
            exitCode = 1;
            break;
          }
          // Smart encoding: binary for byte data, UTF-8 for Unicode text
          await ctx.fs.appendFile(filePath2, stderr, getFileEncoding(stderr));
          stderr = "";
        }
        break;
      }

      case ">&":
      case "<&": {
        // In bash, <& and >& are essentially the same for FD duplication
        // 1<&2 and 1>&2 both make fd 1 point to where fd 2 points
        const fd = redir.fd ?? 1; // Default to stdout (fd 1)
        // Handle >&- or <&- close operation
        // NOTE: For command-level redirections, FD close is TEMPORARY - it only
        // affects the command during its execution. By the time applyRedirections
        // is called, the command has already completed, so we should NOT modify
        // the persistent FD state here. The FD will be restored after this command.
        // Permanent FD closes are handled by `exec N>&-` in executeSimpleCommand.
        if (target === "-") {
          // Don't delete the FD - command-level redirections are temporary
          break;
        }
        // Handle FD move operation: N>&M- (duplicate M to N, then close M)
        // Net-neutral on FD count (set + delete), skip checkFdLimit
        if (target.endsWith("-")) {
          const sourceFdStr = target.slice(0, -1);
          const sourceFd = Number.parseInt(sourceFdStr, 10);
          if (!Number.isNaN(sourceFd)) {
            // First, duplicate: copy the FD content/info from source to target
            const sourceInfo = ctx.state.fileDescriptors?.get(sourceFd);
            if (sourceInfo !== undefined) {
              if (!ctx.state.fileDescriptors) {
                ctx.state.fileDescriptors = new Map();
              }
              ctx.state.fileDescriptors.set(fd, sourceInfo);
              // Then close the source FD (only for user FDs 3+)
              if (sourceFd >= 3) {
                ctx.state.fileDescriptors?.delete(sourceFd);
              }
            } else if (sourceFd === 1 || sourceFd === 2) {
              // Source FD is stdout or stderr which aren't in fileDescriptors
              // Store as duplication marker
              if (!ctx.state.fileDescriptors) {
                ctx.state.fileDescriptors = new Map();
              }
              ctx.state.fileDescriptors.set(fd, `__dupout__:${sourceFd}`);
            } else if (sourceFd === 0) {
              // Source FD is stdin
              if (!ctx.state.fileDescriptors) {
                ctx.state.fileDescriptors = new Map();
              }
              ctx.state.fileDescriptors.set(fd, `__dupin__:${sourceFd}`);
            } else if (sourceFd >= 3) {
              // Source FD is a user FD (3+) that's not in fileDescriptors - bad file descriptor
              stderr += `bash: ${sourceFd}: Bad file descriptor\n`;
              exitCode = 1;
            }
          }
          break;
        }
        // >&2, 1>&2, 1<&2: redirect stdout to stderr
        if (target === "2" || target === "&2") {
          if (fd === 1) {
            stderr += stdout;
            stdout = "";
          }
        }
        // 2>&1, 2<&1: redirect stderr to stdout
        else if (target === "1" || target === "&1") {
          if (fd === 2) {
            stdout += stderr;
            stderr = "";
          } else {
            // 1>&1 is a no-op, but other fds redirect to stdout
            stdout += stderr;
            stderr = "";
          }
        }
        // Handle writing to a user-allocated FD (>&$fd)
        else {
          const targetFd = Number.parseInt(target, 10);
          if (!Number.isNaN(targetFd)) {
            // Check if this is a valid user-allocated FD
            const fdInfo = ctx.state.fileDescriptors?.get(targetFd);
            if (fdInfo?.startsWith("__file__:")) {
              // This FD is associated with a file - write to it
              // The path is already resolved when the FD was allocated
              const resolvedPath = fdInfo.slice(9); // Remove "__file__:" prefix
              if (fd === 1) {
                await ctx.fs.appendFile(
                  resolvedPath,
                  stdout,
                  getStdoutEncoding(stdout)
                );
                stdout = "";
              } else if (fd === 2) {
                await ctx.fs.appendFile(
                  resolvedPath,
                  stderr,
                  getFileEncoding(stderr)
                );
                stderr = "";
              }
            } else if (fdInfo?.startsWith("__rw__:")) {
              // Read/write FD - extract path using proper format parsing
              // Format: __rw__:pathLength:path:position:content
              const parsed = parseRwFdContent(fdInfo);
              if (parsed) {
                if (fd === 1) {
                  await ctx.fs.appendFile(
                    parsed.path,
                    stdout,
                    getStdoutEncoding(stdout)
                  );
                  stdout = "";
                } else if (fd === 2) {
                  await ctx.fs.appendFile(
                    parsed.path,
                    stderr,
                    getFileEncoding(stderr)
                  );
                  stderr = "";
                }
              }
            } else if (fdInfo?.startsWith("__dupout__:")) {
              // FD is duplicated from another FD - resolve the chain
              // __dupout__:N means this FD writes to the same place as FD N
              const sourceFd = Number.parseInt(fdInfo.slice(11), 10);
              if (sourceFd === 1) {
                // Target FD duplicates stdout - output stays on stdout (no-op for 1>&N)
                // stdout remains as is
              } else if (sourceFd === 2) {
                // Target FD duplicates stderr - redirect stdout to stderr
                if (fd === 1) {
                  stderr += stdout;
                  stdout = "";
                }
              } else {
                // Check if sourceFd points to a file
                const sourceInfo = ctx.state.fileDescriptors?.get(sourceFd);
                if (sourceInfo?.startsWith("__file__:")) {
                  const resolvedPath = sourceInfo.slice(9);
                  if (fd === 1) {
                    await ctx.fs.appendFile(
                      resolvedPath,
                      stdout,
                      getStdoutEncoding(stdout)
                    );
                    stdout = "";
                  } else if (fd === 2) {
                    await ctx.fs.appendFile(
                      resolvedPath,
                      stderr,
                      getFileEncoding(stderr)
                    );
                    stderr = "";
                  }
                }
              }
            } else if (fdInfo?.startsWith("__dupin__:")) {
              // FD is duplicated for input - writing to it is an error
              stderr += `bash: ${targetFd}: Bad file descriptor\n`;
              exitCode = 1;
              stdout = "";
            } else if (targetFd >= 3) {
              // User FD range (3+) but FD not found - bad file descriptor
              // For FDs 3-9 (manually allocated) and 10+ (auto-allocated),
              // if the FD is not in fileDescriptors, it means it was closed or never opened
              stderr += `bash: ${targetFd}: Bad file descriptor\n`;
              exitCode = 1;
              stdout = "";
            }
          } else if (redir.operator === ">&") {
            // In bash, N>&word where word is not a number or '-' is treated as a file redirect
            // If no explicit fd (redir.fd == null), redirects BOTH stdout and stderr (equivalent to &>word)
            // If explicit fd (e.g., 1>&word), redirects just that fd to the file
            const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
            const error = await checkOutputRedirectTarget(
              ctx,
              filePath,
              target,
              {
                checkNoclobber: true
              }
            );
            if (error) {
              stderr = error;
              exitCode = 1;
              stdout = "";
              break;
            }
            if (redir.fd == null) {
              // >&word (no explicit fd) - write both stdout and stderr to the file
              const combined = stdout + stderr;
              await ctx.fs.writeFile(
                filePath,
                combined,
                getStdoutEncoding(combined)
              );
              stdout = "";
              stderr = "";
            } else if (fd === 1) {
              // 1>&word - redirect stdout to file
              await ctx.fs.writeFile(
                filePath,
                stdout,
                getStdoutEncoding(stdout)
              );
              stdout = "";
            } else if (fd === 2) {
              // 2>&word - redirect stderr to file
              await ctx.fs.writeFile(filePath, stderr, getFileEncoding(stderr));
              stderr = "";
            }
          }
        }
        break;
      }

      case "&>": {
        // /dev/full always returns ENOSPC when written to
        if (target === "/dev/full") {
          stderr = `bash: echo: write error: No space left on device\n`;
          exitCode = 1;
          stdout = "";
          break;
        }
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        const error = await checkOutputRedirectTarget(ctx, filePath, target, {
          checkNoclobber: true
        });
        if (error) {
          stderr = error;
          exitCode = 1;
          stdout = "";
          break;
        }
        // Smart encoding: binary for byte data, UTF-8 for Unicode text
        const combined = stdout + stderr;
        await ctx.fs.writeFile(filePath, combined, getStdoutEncoding(combined));
        stdout = "";
        stderr = "";
        break;
      }

      case "&>>": {
        // /dev/full always returns ENOSPC when written to
        if (target === "/dev/full") {
          stderr = `bash: echo: write error: No space left on device\n`;
          exitCode = 1;
          stdout = "";
          break;
        }
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        const error = await checkOutputRedirectTarget(
          ctx,
          filePath,
          target,
          {}
        );
        if (error) {
          stderr = error;
          exitCode = 1;
          stdout = "";
          break;
        }
        // Smart encoding: binary for byte data, UTF-8 for Unicode text
        const combined = stdout + stderr;
        await ctx.fs.appendFile(
          filePath,
          combined,
          getStdoutEncoding(combined)
        );
        stdout = "";
        stderr = "";
        break;
      }
    }
  }

  // Apply persistent FD redirections (from exec)
  // Check if fd 1 (stdout) is redirected to fd 2 (stderr) via exec 1>&2
  const fd1Info = ctx.state.fileDescriptors?.get(1);
  if (fd1Info) {
    if (fd1Info === "__dupout__:2") {
      // fd 1 is duplicated to fd 2 - stdout goes to stderr
      stderr += stdout;
      stdout = "";
    } else if (fd1Info.startsWith("__file__:")) {
      // fd 1 is redirected to a file
      const filePath = fd1Info.slice(9);
      await ctx.fs.appendFile(filePath, stdout, getStdoutEncoding(stdout));
      stdout = "";
    } else if (fd1Info.startsWith("__file_append__:")) {
      const filePath = fd1Info.slice(16);
      await ctx.fs.appendFile(filePath, stdout, getStdoutEncoding(stdout));
      stdout = "";
    }
  }

  // Check if fd 2 (stderr) is redirected
  const fd2Info = ctx.state.fileDescriptors?.get(2);
  if (fd2Info) {
    if (fd2Info === "__dupout__:1") {
      // fd 2 is duplicated to fd 1 - stderr goes to stdout
      stdout += stderr;
      stderr = "";
    } else if (fd2Info.startsWith("__file__:")) {
      const filePath = fd2Info.slice(9);
      await ctx.fs.appendFile(filePath, stderr, getFileEncoding(stderr));
      stderr = "";
    } else if (fd2Info.startsWith("__file_append__:")) {
      const filePath = fd2Info.slice(16);
      await ctx.fs.appendFile(filePath, stderr, getFileEncoding(stderr));
      stderr = "";
    }
  }

  return makeResult(stdout, stderr, exitCode);
}
