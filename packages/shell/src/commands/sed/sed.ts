import { sanitizeErrorMessage } from "../../fs/sanitize-error";
import { ExecutionLimitError } from "../../interpreter/errors";
import type { ExecutionLimits } from "../../limits";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";
import {
  createInitialState,
  type ExecuteContext,
  executeCommands
} from "./executor";
import { parseMultipleScripts } from "./parser";
import type {
  RangeState,
  SedCommand,
  SedExecutionLimits,
  SedState
} from "./types";

const sedHelp = {
  name: "sed",
  summary: "stream editor for filtering and transforming text",
  usage: "sed [OPTION]... {script} [input-file]...",
  options: [
    "-n, --quiet, --silent  suppress automatic printing of pattern space",
    "-e script              add the script to commands to be executed",
    "-f script-file         read script from file",
    "-i, --in-place         edit files in place",
    "-E, -r, --regexp-extended  use extended regular expressions",
    "    --help             display this help and exit"
  ],
  description: `Commands:
  s/regexp/replacement/[flags]  substitute
  d                             delete pattern space
  p                             print pattern space
  a\\ text                       append text after line
  i\\ text                       insert text before line
  c\\ text                       change (replace) line with text
  h                             copy pattern space to hold space
  H                             append pattern space to hold space
  g                             copy hold space to pattern space
  G                             append hold space to pattern space
  x                             exchange pattern and hold spaces
  n                             read next line into pattern space
  N                             append next line to pattern space
  y/source/dest/                transliterate characters
  =                             print line number
  l                             list pattern space (escape special chars)
  b [label]                     branch to label
  t [label]                     branch on substitution
  T [label]                     branch if no substitution
  :label                        define label
  q                             quit
  Q                             quit without printing

Addresses:
  N                             line number
  $                             last line
  /regexp/                      lines matching regexp
  N,M                           range from line N to M
  first~step                    every step-th line starting at first`
};

interface ProcessContentOptions {
  limits?: Required<ExecutionLimits>;
  filename?: string;
  fs?: CommandContext["fs"];
  cwd?: string;
}

async function processContent(
  content: string,
  commands: SedCommand[],
  silent: boolean,
  options: ProcessContentOptions = {}
): Promise<{ output: string; exitCode?: number; errorMessage?: string }> {
  const { limits, filename, fs, cwd } = options;
  const withDefenseContext = <T>(
    _phase: string,
    op: () => Promise<T>
  ): Promise<T> => op();

  // Track if input ended with newline - needed for preserving trailing newline behavior
  const inputEndsWithNewline = content.endsWith("\n");

  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const totalLines = lines.length;
  let output = "";
  let exitCode: number | undefined;
  // Track if the last output came from auto-print (to determine trailing newline behavior)
  // Only auto-print should have its trailing newline stripped when input has no trailing newline
  let lastOutputWasAutoPrint = false;

  // Extract max output size from limits
  const maxOutputSize = limits?.maxStringLength ?? 0;
  const appendOutput = (text: string): void => {
    output += text;
    if (maxOutputSize > 0 && output.length > maxOutputSize) {
      throw new ExecutionLimitError(
        `sed: output size limit exceeded (${maxOutputSize} bytes)`,
        "string_length"
      );
    }
  };

  // Persistent state across all lines
  let holdSpace = "";
  let lastPattern: string | undefined;
  const rangeStates = new Map<string, RangeState>();

  // For file I/O: track line positions for R command, accumulate writes
  const fileLineCache = new Map<string, string[]>();
  const fileLinePositions = new Map<string, number>();
  const fileWrites = new Map<string, string>();

  // Convert to SedExecutionLimits format
  const sedLimits: SedExecutionLimits | undefined = limits
    ? {
        maxIterations: limits.maxSedIterations,
        maxStringLength: maxOutputSize
      }
    : undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const state: SedState = {
      ...createInitialState(totalLines, filename, rangeStates),
      patternSpace: lines[lineIndex],
      holdSpace: holdSpace,
      lastPattern: lastPattern,
      lineNumber: lineIndex + 1,
      totalLines,
      substitutionMade: false // Reset for each new line (T command behavior)
    };

    // Create execution context for N command
    const ctx: ExecuteContext = {
      lines,
      currentLineIndex: lineIndex
    };

    // Execute commands with support for D command cycle restart
    let cycleIterations = 0;
    const maxCycleIterations = 10000;
    // Reset lines consumed counter for this cycle
    state.linesConsumedInCycle = 0;
    do {
      cycleIterations++;
      if (cycleIterations > maxCycleIterations) {
        // Prevent infinite loops
        break;
      }

      state.restartCycle = false;
      state.pendingFileReads = [];
      state.pendingFileWrites = [];

      // Execute commands - lines consumed are tracked in state.linesConsumedInCycle
      executeCommands(commands, state, ctx, sedLimits);

      // Process pending file reads
      if (fs && cwd) {
        for (const read of state.pendingFileReads) {
          const filePath = fs.resolvePath(cwd, read.filename);
          try {
            if (read.wholeFile) {
              // r command - read entire file, append after current line
              const fileContent = await withDefenseContext(
                "read command file",
                () => fs.readFile(filePath)
              );
              state.appendBuffer.push(fileContent.replace(/\n$/, ""));
            } else {
              // R command - read one line from file
              if (!fileLineCache.has(filePath)) {
                const fileContent = await withDefenseContext(
                  "read command file line cache",
                  () => fs.readFile(filePath)
                );
                fileLineCache.set(filePath, fileContent.split("\n"));
                fileLinePositions.set(filePath, 0);
              }
              const fileLines = fileLineCache.get(filePath);
              const pos = fileLinePositions.get(filePath);
              if (fileLines && pos !== undefined && pos < fileLines.length) {
                state.appendBuffer.push(fileLines[pos]);
                fileLinePositions.set(filePath, pos + 1);
              }
            }
          } catch (e) {
            if (e instanceof ExecutionLimitError) {
              throw e;
            }
            // File not found - silently ignore (matches GNU sed behavior)
          }
        }

        // Accumulate file writes
        for (const write of state.pendingFileWrites) {
          const filePath = fs.resolvePath(cwd, write.filename);
          const existing = fileWrites.get(filePath) || "";
          fileWrites.set(filePath, existing + write.content);
        }
      }
    } while (
      state.restartCycle &&
      !state.deleted &&
      !state.quit &&
      !state.quitSilent
    );

    // Update main line index with total lines consumed during this cycle
    lineIndex += state.linesConsumedInCycle;

    // Preserve state for next line
    holdSpace = state.holdSpace;
    lastPattern = state.lastPattern;

    // Output from n command (respects silent mode) - must come before other outputs
    if (!silent) {
      for (const ln of state.nCommandOutput) {
        appendOutput(`${ln}\n`);
      }
    }

    // Output line numbers from = command (and l, F commands, p command)
    const hadLineNumberOutput = state.lineNumberOutput.length > 0;
    for (const ln of state.lineNumberOutput) {
      appendOutput(`${ln}\n`);
    }

    // Handle insert commands (marked with __INSERT__ prefix)
    const inserts: string[] = [];
    const appends: string[] = [];
    for (const item of state.appendBuffer) {
      if (item.startsWith("__INSERT__")) {
        inserts.push(item.slice(10));
      } else {
        appends.push(item);
      }
    }

    // Output inserts before the line
    for (const text of inserts) {
      appendOutput(`${text}\n`);
    }

    // Handle output - Q (quitSilent) suppresses the final print
    // Track whether output came from auto-print or explicit print (for trailing newline handling)
    let hadPatternSpaceOutput = false;
    if (!state.deleted && !state.quitSilent) {
      if (silent) {
        if (state.printed) {
          appendOutput(`${state.patternSpace}\n`);
          hadPatternSpaceOutput = true; // Explicit print in silent mode
        }
      } else {
        appendOutput(`${state.patternSpace}\n`);
        hadPatternSpaceOutput = true; // Auto-print in non-silent mode
      }
    } else if (state.changedText !== undefined) {
      // c command: output changed text in place of pattern space
      appendOutput(`${state.changedText}\n`);
      hadPatternSpaceOutput = true;
    }

    // Output appends after the line
    for (const text of appends) {
      appendOutput(`${text}\n`);
    }

    // Track if this line produced output that should have trailing newline stripped
    // This includes: explicit print (lineNumberOutput from p command or /p flag),
    // pattern space output (auto-print or explicit via state.printed), but NOT appends
    const hadOutput = hadLineNumberOutput || hadPatternSpaceOutput;
    lastOutputWasAutoPrint = hadOutput && appends.length === 0;

    // Check for quit commands or errors
    if (state.quit || state.quitSilent) {
      if (state.exitCode !== undefined) {
        exitCode = state.exitCode;
      }
      if (state.errorMessage) {
        // Early exit on error
        return {
          output: "",
          exitCode: exitCode || 1,
          errorMessage: state.errorMessage
        };
      }
      break;
    }
  }

  // Flush all accumulated file writes at end
  if (fs && cwd) {
    for (const [filePath, fileContent] of fileWrites) {
      try {
        await withDefenseContext("flush pending file writes", () =>
          fs.writeFile(filePath, fileContent)
        );
      } catch (e) {
        if (e instanceof ExecutionLimitError) {
          throw e;
        }
        // Write error - silently ignore for now
      }
    }
  }

  // If input didn't end with newline, strip trailing newline from output
  // BUT only if the last output was from auto-print (non-silent mode, no explicit prints/appends)
  if (
    !inputEndsWithNewline &&
    lastOutputWasAutoPrint &&
    output.endsWith("\n")
  ) {
    output = output.slice(0, -1);
  }

  return { output, exitCode };
}

export const sedCommand: Command = {
  name: "sed",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const withDefenseContext = <T>(
      _phase: string,
      op: () => Promise<T>
    ): Promise<T> => op();

    if (hasHelpFlag(args)) {
      return showHelp(sedHelp);
    }

    const scripts: string[] = [];
    const scriptFiles: string[] = [];
    let silent = false;
    let inPlace = false;
    let extendedRegex = false;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
        silent = true;
      } else if (arg === "-i" || arg === "--in-place") {
        inPlace = true;
      } else if (arg.startsWith("-i")) {
        inPlace = true;
      } else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") {
        extendedRegex = true;
      } else if (arg === "-e") {
        if (i + 1 < args.length) {
          scripts.push(args[++i]);
        }
      } else if (arg === "-f") {
        if (i + 1 < args.length) {
          scriptFiles.push(args[++i]);
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("sed", arg);
      } else if (arg === "-") {
        // "-" is stdin marker, treat as a file
        files.push(arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const c of arg.slice(1)) {
          if (
            c !== "n" &&
            c !== "e" &&
            c !== "f" &&
            c !== "i" &&
            c !== "E" &&
            c !== "r"
          ) {
            return unknownOption("sed", `-${c}`);
          }
        }
        if (arg.includes("n")) silent = true;
        if (arg.includes("i")) inPlace = true;
        if (arg.includes("E") || arg.includes("r")) extendedRegex = true;
        if (arg.includes("e") && !arg.includes("n") && !arg.includes("i")) {
          if (i + 1 < args.length) {
            scripts.push(args[++i]);
          }
        }
        if (arg.includes("f") && !arg.includes("e")) {
          if (i + 1 < args.length) {
            scriptFiles.push(args[++i]);
          }
        }
      } else if (
        !arg.startsWith("-") &&
        scripts.length === 0 &&
        scriptFiles.length === 0
      ) {
        scripts.push(arg);
      } else if (!arg.startsWith("-")) {
        files.push(arg);
      }
    }

    // Read scripts from -f files
    for (const scriptFile of scriptFiles) {
      const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptFile);
      try {
        const scriptContent = await withDefenseContext("script file read", () =>
          ctx.fs.readFile(scriptPath)
        );
        // Split by newlines and add each line as a separate script
        for (const line of scriptContent.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            scripts.push(trimmed);
          }
        }
      } catch (e) {
        if (e instanceof ExecutionLimitError) {
          throw e;
        }
        return {
          stdout: "",
          stderr: `sed: couldn't open file ${scriptFile}: No such file or directory\n`,
          exitCode: 1
        };
      }
    }

    if (scripts.length === 0) {
      return {
        stdout: "",
        stderr: "sed: no script specified\n",
        exitCode: 1
      };
    }

    // Parse all scripts
    const { commands, error, silentMode } = parseMultipleScripts(
      scripts,
      extendedRegex
    );
    if (error) {
      return {
        stdout: "",
        stderr: `sed: ${error}\n`,
        exitCode: 1
      };
    }

    // Note: empty script (no commands) is valid in sed - just passes through input

    // Enable silent mode from -n flag or #n comment
    const effectiveSilent = !!(silent || silentMode);

    // Handle in-place editing - check this first because -i requires files
    if (inPlace) {
      // -i requires at least one file argument
      if (files.length === 0) {
        return {
          stdout: "",
          stderr: "sed: -i requires at least one file argument\n",
          exitCode: 1
        };
      }
      for (const file of files) {
        // Skip "-" for in-place editing (can't edit stdin in-place)
        if (file === "-") {
          continue;
        }
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          const fileContent = await withDefenseContext(
            "in-place input read",
            () => ctx.fs.readFile(filePath)
          );
          const result = await withDefenseContext("in-place processing", () =>
            processContent(fileContent, commands, effectiveSilent, {
              limits: ctx.limits,
              filename: file,
              fs: ctx.fs,
              cwd: ctx.cwd
            })
          );
          if (result.errorMessage) {
            return {
              stdout: "",
              stderr: `${result.errorMessage}\n`,
              exitCode: result.exitCode ?? 1
            };
          }
          await withDefenseContext("in-place output write", () =>
            ctx.fs.writeFile(filePath, result.output)
          );
        } catch (e) {
          if (e instanceof ExecutionLimitError) {
            throw e;
          }
          if (e instanceof ExecutionLimitError) {
            const message = sanitizeErrorMessage(e.message);
            return {
              stdout: "",
              stderr: `sed: ${message}\n`,
              exitCode: ExecutionLimitError.EXIT_CODE
            };
          }
          return {
            stdout: "",
            stderr: `sed: ${file}: No such file or directory\n`,
            exitCode: 1
          };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    let content = "";

    // Read from files or stdin
    if (files.length === 0) {
      content = ctx.stdin;
      try {
        const result = await withDefenseContext("stdin processing", () =>
          processContent(content, commands, effectiveSilent, {
            limits: ctx.limits,
            fs: ctx.fs,
            cwd: ctx.cwd
          })
        );
        return {
          stdout: result.output,
          stderr: result.errorMessage ? `${result.errorMessage}\n` : "",
          exitCode: result.exitCode ?? 0
        };
      } catch (e) {
        if (e instanceof ExecutionLimitError) {
          throw e;
        }
        if (e instanceof ExecutionLimitError) {
          const message = sanitizeErrorMessage(e.message);
          return {
            stdout: "",
            stderr: `sed: ${message}\n`,
            exitCode: ExecutionLimitError.EXIT_CODE
          };
        }
        throw e;
      }
    }

    // Read all files and process
    // Support "-" as stdin marker
    let stdinConsumed = false;
    for (const file of files) {
      let fileContent: string;
      if (file === "-") {
        // "-" means read from stdin (can only be consumed once)
        if (stdinConsumed) {
          fileContent = "";
        } else {
          fileContent = ctx.stdin;
          stdinConsumed = true;
        }
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          fileContent = await withDefenseContext("input file read", () =>
            ctx.fs.readFile(filePath)
          );
        } catch (e) {
          if (e instanceof ExecutionLimitError) {
            throw e;
          }
          if (e instanceof ExecutionLimitError) {
            const message = sanitizeErrorMessage(e.message);
            return {
              stdout: "",
              stderr: `sed: ${message}\n`,
              exitCode: ExecutionLimitError.EXIT_CODE
            };
          }
          return {
            stdout: "",
            stderr: `sed: ${file}: No such file or directory\n`,
            exitCode: 1
          };
        }
      }
      // When concatenating files, ensure previous content ends with newline
      // (unless this is the first file, previous content is empty, or new content is empty)
      if (
        content.length > 0 &&
        fileContent.length > 0 &&
        !content.endsWith("\n")
      ) {
        content += "\n";
      }
      content += fileContent;
    }

    try {
      const result = await withDefenseContext("final processing", () =>
        processContent(content, commands, effectiveSilent, {
          limits: ctx.limits,
          filename: files.length === 1 ? files[0] : undefined,
          fs: ctx.fs,
          cwd: ctx.cwd
        })
      );
      return {
        stdout: result.output,
        stderr: result.errorMessage ? `${result.errorMessage}\n` : "",
        exitCode: result.exitCode ?? 0
      };
    } catch (e) {
      if (e instanceof ExecutionLimitError) {
        throw e;
      }
      if (e instanceof ExecutionLimitError) {
        const message = sanitizeErrorMessage(e.message);
        return {
          stdout: "",
          stderr: `sed: ${message}\n`,
          exitCode: ExecutionLimitError.EXIT_CODE
        };
      }
      throw e;
    }
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "sed",
  flags: [
    { flag: "-n", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-E", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-e", type: "value", valueHint: "string" }
  ],
  stdinType: "text",
  needsArgs: true
};
