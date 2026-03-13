/**
 * Shell - Runtime-Agnostic Bash Interpreter
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * Forked from just-bash (Apache-2.0, Vercel Labs).
 * Heavyweight capabilities (SQL, code execution, markdown conversion) are
 * externalized behind pluggable interfaces instead of being bundled.
 */

import type { FunctionDefNode } from "./ast/types";
import {
  type CommandName,
  createLazyCommands,
  createNetworkCommands,
  createSqlCommands,
  createCodeExecutorCommands,
  createMarkdownCommands
} from "./commands/registry";
import {
  type CustomCommand,
  createLazyCustomCommand,
  isLazyCommand
} from "./custom-commands";
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs";
import { initFilesystem } from "./fs/init";
import type { IFileSystem, InitialFiles } from "./fs/interface";
import { sanitizeErrorMessage } from "./fs/sanitize-error";
import { mapToRecord, mapToRecordWithExtras } from "./helpers/env";
import {
  ArithmeticError,
  ExecutionAbortedError,
  ExecutionLimitError,
  ExitError,
  PosixFatalError
} from "./interpreter/errors";
import { buildBashopts, buildShellopts } from "./interpreter/helpers/shellopts";
import {
  Interpreter,
  type InterpreterOptions,
  type InterpreterState
} from "./interpreter/index";
import { type ExecutionLimits, resolveLimits } from "./limits";
import {
  createSecureFetch,
  type NetworkConfig,
  type SecureFetch
} from "./network/index";
import { LexerError } from "./parser/lexer";
import { type ParseException, parse } from "./parser/parser";
import type {
  BashExecResult,
  Command,
  CommandRegistry,
  TraceCallback
} from "./types";
import type {
  SqlExecutor,
  CodeExecutor,
  MarkdownConverter
} from "./interfaces";

export type { ExecutionLimits } from "./limits";

/**
 * Logger interface for Shell execution logging.
 */
export interface ShellLogger {
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// Compat alias
export type BashLogger = ShellLogger;

export interface ShellOptions {
  files?: InitialFiles;
  env?: Record<string, string>;
  cwd?: string;
  fs?: IFileSystem;
  executionLimits?: ExecutionLimits;
  /** @deprecated Use executionLimits.maxCallDepth instead */
  maxCallDepth?: number;
  /** @deprecated Use executionLimits.maxCommandCount instead */
  maxCommandCount?: number;
  /** @deprecated Use executionLimits.maxLoopIterations instead */
  maxLoopIterations?: number;
  /**
   * Custom secure fetch function. When provided, used instead of creating one
   * from NetworkConfig. Network commands (curl) are registered when either
   * `fetch` or `network` is provided.
   */
  fetch?: SecureFetch;
  /** Network configuration for curl. Disabled by default. */
  network?: NetworkConfig;
  /**
   * SQL executor for the sqlite3 command.
   * When provided, sqlite3 becomes available.
   */
  sql?: SqlExecutor;
  /**
   * Code executor for js-exec/node/python3/python commands.
   * When provided, these commands become available.
   */
  executor?: CodeExecutor;
  /**
   * Markdown converter for the html-to-markdown command.
   * When provided, html-to-markdown becomes available.
   */
  markdown?: MarkdownConverter;
  /**
   * Optional list of command names to register.
   * If not provided, all built-in commands are available.
   */
  commands?: CommandName[];
  /** Custom sleep function (for testing with mock clocks). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Custom commands to register alongside built-in commands.
   * These take precedence over built-ins with the same name.
   */
  customCommands?: CustomCommand[];
  /** Optional logger for execution tracing. */
  logger?: ShellLogger;
  /** Optional trace callback for performance profiling. */
  trace?: TraceCallback;
  /** Virtual process info for sandboxed environment. */
  processInfo?: {
    pid?: number;
    ppid?: number;
    uid?: number;
    gid?: number;
  };
}

// Compat alias
export type BashOptions = ShellOptions;

export interface ExecOptions {
  env?: Record<string, string>;
  replaceEnv?: boolean;
  cwd?: string;
  rawScript?: boolean;
  stdin?: string;
  signal?: AbortSignal;
  args?: string[];
}

export interface ShellExecResult extends BashExecResult {
  env: Record<string, string>;
}

// Compat alias
export type BashExecResult_ = ShellExecResult;

export class Shell {
  readonly fs: IFileSystem;
  private commands: CommandRegistry = new Map();
  private useDefaultLayout: boolean = false;
  private limits: Required<ExecutionLimits>;
  private secureFetch?: SecureFetch;
  private sleepFn?: (ms: number) => Promise<void>;
  private traceFn?: TraceCallback;
  private logger?: ShellLogger;

  // Interpreter state (shared with interpreter instances)
  private state: InterpreterState;

  constructor(options: ShellOptions = {}) {
    const fs = options.fs ?? new InMemoryFs(options.files);
    this.fs = fs;

    this.useDefaultLayout = !options.cwd && !options.files;
    const cwd = options.cwd || (this.useDefaultLayout ? "/home/user" : "/");
    const env = new Map<string, string>([
      ["HOME", this.useDefaultLayout ? "/home/user" : "/"],
      ["PATH", "/usr/bin:/bin"],
      ["IFS", " \t\n"],
      ["OSTYPE", "linux-gnu"],
      ["MACHTYPE", "x86_64-pc-linux-gnu"],
      ["HOSTTYPE", "x86_64"],
      ["HOSTNAME", "localhost"],
      ["PWD", cwd],
      ["OLDPWD", cwd],
      ["OPTIND", "1"],
      ...Object.entries(options.env ?? {})
    ]);

    this.limits = resolveLimits({
      ...options.executionLimits,
      ...(options.maxCallDepth !== undefined && {
        maxCallDepth: options.maxCallDepth
      }),
      ...(options.maxCommandCount !== undefined && {
        maxCommandCount: options.maxCommandCount
      }),
      ...(options.maxLoopIterations !== undefined && {
        maxLoopIterations: options.maxLoopIterations
      })
    });

    if (options.fetch) {
      this.secureFetch = options.fetch;
    } else if (options.network) {
      this.secureFetch = createSecureFetch(options.network);
    }

    this.sleepFn = options.sleep;
    this.traceFn = options.trace;
    this.logger = options.logger;

    this.state = {
      env,
      cwd,
      previousDir: "/home/user",
      functions: new Map<string, FunctionDefNode>(),
      localScopes: [],
      callDepth: 0,
      sourceDepth: 0,
      commandCount: 0,
      lastExitCode: 0,
      lastArg: "",
      startTime: Date.now(),
      lastBackgroundPid: 0,
      virtualPid: options.processInfo?.pid ?? 1,
      virtualPpid: options.processInfo?.ppid ?? 0,
      virtualUid: options.processInfo?.uid ?? 1000,
      virtualGid: options.processInfo?.gid ?? 1000,
      bashPid: options.processInfo?.pid ?? 1,
      nextVirtualPid: (options.processInfo?.pid ?? 1) + 1,
      currentLine: 1,
      options: {
        errexit: false,
        pipefail: false,
        nounset: false,
        xtrace: false,
        verbose: false,
        posix: false,
        allexport: false,
        noclobber: false,
        noglob: false,
        noexec: false,
        vi: false,
        emacs: false
      },
      shoptOptions: {
        extglob: false,
        dotglob: false,
        nullglob: false,
        failglob: false,
        globstar: false,
        globskipdots: true,
        nocaseglob: false,
        nocasematch: false,
        expand_aliases: false,
        lastpipe: false,
        xpg_echo: false
      },
      inCondition: false,
      loopDepth: 0,
      exportedVars: new Set([
        "HOME",
        "PATH",
        "PWD",
        "OLDPWD",
        ...Object.keys(options.env || {})
      ]),
      readonlyVars: new Set(["SHELLOPTS", "BASHOPTS"]),
      hashTable: new Map()
    };

    this.state.env.set("SHELLOPTS", buildShellopts(this.state.options));
    this.state.env.set("BASHOPTS", buildBashopts(this.state.shoptOptions));

    initFilesystem(fs, this.useDefaultLayout, {
      pid: this.state.virtualPid,
      ppid: this.state.virtualPpid,
      uid: this.state.virtualUid,
      gid: this.state.virtualGid
    });

    if (cwd !== "/" && fs instanceof InMemoryFs) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch {
        // Ignore errors
      }
    }

    for (const cmd of createLazyCommands(options.commands)) {
      this.registerCommand(cmd);
    }

    // Register network commands when fetch or network is configured
    if (options.fetch || options.network) {
      for (const cmd of createNetworkCommands()) {
        this.registerCommand(cmd);
      }
    }

    // Register SQL commands when sql executor is provided
    if (options.sql) {
      for (const cmd of createSqlCommands(options.sql)) {
        this.registerCommand(cmd);
      }
    }

    // Register code executor commands when executor is provided
    if (options.executor) {
      for (const cmd of createCodeExecutorCommands(options.executor)) {
        this.registerCommand(cmd);
      }
    }

    // Register markdown commands when converter is provided
    if (options.markdown) {
      for (const cmd of createMarkdownCommands(options.markdown)) {
        this.registerCommand(cmd);
      }
    }

    // Register custom commands (after built-ins so they can override)
    if (options.customCommands) {
      for (const cmd of options.customCommands) {
        if (isLazyCommand(cmd)) {
          this.registerCommand(createLazyCustomCommand(cmd));
        } else {
          this.registerCommand({
            ...cmd,
            trusted: cmd.trusted ?? true
          });
        }
      }
    }
  }

  registerCommand(command: Command): void {
    this.commands.set(command.name, command);
    const fs = this.fs as {
      writeFileSync?: (path: string, content: string) => void;
    };
    if (typeof fs.writeFileSync === "function") {
      const stub = `#!/bin/bash\n# Built-in command: ${command.name}\n`;
      try {
        fs.writeFileSync(`/bin/${command.name}`, stub);
      } catch {
        // Ignore errors
      }
      try {
        fs.writeFileSync(`/usr/bin/${command.name}`, stub);
      } catch {
        // Ignore errors
      }
    }
  }

  private logResult(result: BashExecResult): ShellExecResult {
    if (this.logger) {
      if (result.stdout) {
        this.logger.debug("stdout", { output: result.stdout });
      }
      if (result.stderr) {
        this.logger.info("stderr", { output: result.stderr });
      }
      this.logger.info("exit", { exitCode: result.exitCode });
    }
    result.stdout = decodeBinaryToUtf8(result.stdout);
    result.stderr = decodeBinaryToUtf8(result.stderr);
    return result as ShellExecResult;
  }

  async exec(
    commandLine: string,
    options?: ExecOptions
  ): Promise<ShellExecResult> {
    if (this.state.callDepth === 0) {
      this.state.commandCount = 0;
    }

    this.state.commandCount++;
    if (this.state.commandCount > this.limits.maxCommandCount) {
      return {
        stdout: "",
        stderr: `bash: maximum command count (${this.limits.maxCommandCount}) exceeded (possible infinite loop). Increase with executionLimits.maxCommandCount option.\n`,
        exitCode: 1,
        env: mapToRecordWithExtras(this.state.env, options?.env)
      };
    }

    if (!commandLine.trim()) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: mapToRecordWithExtras(this.state.env, options?.env)
      };
    }

    this.logger?.info("exec", { command: commandLine });

    const effectiveCwd = options?.cwd ?? this.state.cwd;

    let newPwd: string | undefined;
    let newCwd = effectiveCwd;
    if (options?.cwd) {
      if (options.env && "PWD" in options.env) {
        newPwd = options.env.PWD;
      } else if (options?.env && !("PWD" in options.env)) {
        try {
          newPwd = await this.fs.realpath(effectiveCwd);
          newCwd = newPwd;
        } catch {
          newPwd = effectiveCwd;
        }
      } else {
        newPwd = effectiveCwd;
      }
    }

    const execEnv = options?.replaceEnv
      ? new Map<string, string>()
      : new Map(this.state.env);
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        execEnv.set(key, value);
      }
    }
    if (newPwd !== undefined) {
      execEnv.set("PWD", newPwd);
    }

    const execState: InterpreterState = {
      ...this.state,
      env: execEnv,
      cwd: newCwd,
      functions: new Map(this.state.functions),
      localScopes: [...this.state.localScopes],
      options: { ...this.state.options },
      hashTable: this.state.hashTable,
      groupStdin: options?.stdin,
      signal: options?.signal,
      extraArgs: options?.args
    };

    let normalized = commandLine;
    if (!options?.rawScript) {
      normalized = normalizeScript(commandLine);
    }

    try {
      const ast = parse(normalized, {
        maxHeredocSize: this.limits.maxHeredocSize
      });

      const interpreterOptions: InterpreterOptions = {
        fs: this.fs,
        commands: this.commands,
        limits: this.limits,
        exec: this.exec.bind(this),
        fetch: this.secureFetch,
        sleep: this.sleepFn,
        trace: this.traceFn
      };

      const interpreter = new Interpreter(interpreterOptions, execState);
      const result = await interpreter.executeScript(ast);
      return this.logResult(result as BashExecResult);
    } catch (error) {
      if (error instanceof ExitError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if (error instanceof PosixFatalError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if (error instanceof ArithmeticError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if (error instanceof ExecutionAbortedError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 124,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if (error instanceof ExecutionLimitError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: sanitizeErrorMessage(error.stderr),
          exitCode: ExecutionLimitError.EXIT_CODE,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if ((error as ParseException).name === "ParseException") {
        return this.logResult({
          stdout: "",
          stderr: `bash: syntax error: ${sanitizeErrorMessage((error as Error).message)}\n`,
          exitCode: 2,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if (error instanceof LexerError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 2,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      if (error instanceof RangeError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env)
        });
      }
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    return this.fs.readFile(this.fs.resolvePath(this.state.cwd, path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.fs.writeFile(
      this.fs.resolvePath(this.state.cwd, path),
      content
    );
  }

  getCwd(): string {
    return this.state.cwd;
  }

  getEnv(): Record<string, string> {
    return mapToRecord(this.state.env);
  }
}

// Drop-in compat alias
export { Shell as Bash };

/**
 * Normalize a script by stripping leading whitespace from lines,
 * while preserving whitespace inside heredoc content.
 */
function normalizeScript(script: string): string {
  const lines = script.split("\n");
  const result: string[] = [];

  const pendingDelimiters: { delimiter: string; stripTabs: boolean }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[pendingDelimiters.length - 1];
      const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (lineToCheck === current.delimiter) {
        result.push(line.trimStart());
        pendingDelimiters.pop();
        continue;
      }
      result.push(line);
      continue;
    }

    const normalizedLine = line.trimStart();
    result.push(normalizedLine);

    const heredocPattern = /<<(-?)\s*(['"]?)([\w-]+)\2/g;
    for (const match of normalizedLine.matchAll(heredocPattern)) {
      const stripTabs = match[1] === "-";
      const delimiter = match[3];
      pendingDelimiters.push({ delimiter, stripTabs });
    }
  }

  return result.join("\n");
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeBinaryToUtf8(s: string): string {
  if (!s) return s;

  let hasHighByte = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) {
      return s;
    }
    if (code > 0x7f) {
      hasHighByte = true;
    }
  }
  if (!hasHighByte) return s;

  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }

  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return s;
  }
}
