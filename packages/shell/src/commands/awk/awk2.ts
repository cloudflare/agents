/**
 * AWK Command - New AST-based Implementation
 *
 * This is the new implementation using proper lexer/parser/interpreter architecture.
 */

import { mapToRecord } from "../../helpers/env";
import { ExecutionLimitError } from "../../interpreter/errors";
import { ConstantRegex, createUserRegex } from "../../regex/index";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";
import type { AwkProgram } from "./ast";
import {
  type AwkFileSystem,
  AwkInterpreter,
  createRuntimeContext
} from "./interpreter/index";
import { AwkParser } from "./parser2";

const awkHelp = {
  name: "awk",
  summary: "pattern scanning and text processing language",
  usage: "awk [OPTIONS] 'PROGRAM' [FILE...]",
  options: [
    "-F FS      use FS as field separator",
    "-v VAR=VAL assign VAL to variable VAR",
    "    --help display this help and exit"
  ]
};

export const awkCommand2: Command = {
  name: "awk",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const withDefenseContext = <T>(
      _phase: string,
      op: () => Promise<T>
    ): Promise<T> => op();

    if (hasHelpFlag(args)) {
      return showHelp(awkHelp);
    }

    let fieldSep: import("../../regex/index.js").RegexLike = new ConstantRegex(
      /\s+/
    );
    let fieldSepStr = " ";
    // Use null-prototype to prevent prototype pollution with user-controlled -v names
    const vars: Record<string, string | number> = Object.create(null);
    let programIdx = 0;

    // Parse options
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-F" && i + 1 < args.length) {
        fieldSepStr = processEscapes(args[++i]);
        fieldSep = createFieldSepRegex(fieldSepStr);
        programIdx = i + 1;
      } else if (arg.startsWith("-F")) {
        fieldSepStr = processEscapes(arg.slice(2));
        fieldSep = createFieldSepRegex(fieldSepStr);
        programIdx = i + 1;
      } else if (arg === "-v" && i + 1 < args.length) {
        const assignment = args[++i];
        const eqIdx = assignment.indexOf("=");
        if (eqIdx > 0) {
          const varName = assignment.slice(0, eqIdx);
          const varValue = processEscapes(assignment.slice(eqIdx + 1));
          vars[varName] = varValue;
        }
        programIdx = i + 1;
      } else if (arg.startsWith("--")) {
        return unknownOption("awk", arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        const optChar = arg[1];
        if (optChar !== "F" && optChar !== "v") {
          return unknownOption("awk", `-${optChar}`);
        }
        programIdx = i + 1;
      } else if (!arg.startsWith("-")) {
        programIdx = i;
        break;
      }
    }

    if (programIdx >= args.length) {
      return { stdout: "", stderr: "awk: missing program\n", exitCode: 1 };
    }

    const program = args[programIdx];
    const files = args.slice(programIdx + 1);

    // Parse program
    const parser = new AwkParser();
    let ast: AwkProgram;
    try {
      ast = parser.parse(program);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: "", stderr: `awk: ${msg}\n`, exitCode: 1 };
    }

    // Create filesystem adapter with appendFile support
    const awkFs: AwkFileSystem = {
      readFile: ctx.fs.readFile.bind(ctx.fs),
      writeFile: ctx.fs.writeFile.bind(ctx.fs),
      appendFile: async (path: string, content: string) => {
        // Append by reading existing content and writing back
        try {
          const existing = await withDefenseContext("appendFile read", () =>
            ctx.fs.readFile(path)
          );
          await withDefenseContext("appendFile write", () =>
            ctx.fs.writeFile(path, existing + content)
          );
        } catch (e) {
          if (e instanceof ExecutionLimitError) {
            throw e;
          }
          // File doesn't exist, just write
          await withDefenseContext("appendFile create", () =>
            ctx.fs.writeFile(path, content)
          );
        }
      },
      resolvePath: ctx.fs.resolvePath.bind(ctx.fs)
    };

    // Create runtime context
    const execFn = ctx.exec;
    const runtimeCtx = createRuntimeContext({
      fieldSep,
      maxIterations: ctx.limits?.maxAwkIterations,
      maxOutputSize: ctx.limits?.maxStringLength,
      fs: awkFs,
      cwd: ctx.cwd,
      // Wrap ctx.exec to match the expected signature for command pipe getline
      exec: execFn
        ? (cmd: string) =>
            withDefenseContext("command pipe exec", () =>
              execFn(cmd, { cwd: ctx.cwd, signal: ctx.signal })
            )
        : undefined
    });
    runtimeCtx.FS = fieldSepStr;
    // Use Object.assign with null-prototype to preserve safety
    runtimeCtx.vars = Object.assign(Object.create(null), vars);

    // Set up ARGC/ARGV
    // ARGV[0] is "awk", ARGV[1..n] are the input files
    runtimeCtx.ARGC = files.length + 1;
    // Use null-prototype to prevent prototype pollution
    runtimeCtx.ARGV = Object.create(null);
    runtimeCtx.ARGV["0"] = "awk";
    for (let i = 0; i < files.length; i++) {
      runtimeCtx.ARGV[String(i + 1)] = files[i];
    }

    // Set up ENVIRON from shell environment (null-prototype prevents prototype pollution)
    runtimeCtx.ENVIRON = mapToRecord(ctx.env);

    // Create interpreter
    const interp = new AwkInterpreter(runtimeCtx);
    interp.execute(ast);

    // Check if there are main rules (non-BEGIN/END patterns)
    const hasMainRules = ast.rules.some(
      (rule) => rule.pattern?.type !== "begin" && rule.pattern?.type !== "end"
    );
    // Check if there are END blocks (need to read files to populate NR)
    const hasEndBlocks = ast.rules.some((rule) => rule.pattern?.type === "end");

    // Execute BEGIN blocks
    try {
      await withDefenseContext("BEGIN execution", () => interp.executeBegin());
      if (runtimeCtx.shouldExit) {
        // exit in BEGIN still runs END blocks (AWK semantics)
        await withDefenseContext("END execution after BEGIN exit", () =>
          interp.executeEnd()
        );
        return {
          stdout: interp.getOutput(),
          stderr: "",
          exitCode: interp.getExitCode()
        };
      }

      // Only skip file reading if there are no main rules AND no END blocks
      // END blocks need NR to be populated from reading files
      if (!hasMainRules && !hasEndBlocks) {
        // Just run END blocks (none), no input processing needed
        return {
          stdout: interp.getOutput(),
          stderr: "",
          exitCode: interp.getExitCode()
        };
      }

      // Collect file contents
      interface FileData {
        filename: string;
        lines: string[];
      }
      const fileDataList: FileData[] = [];

      if (files.length > 0) {
        for (const file of files) {
          try {
            const filePath = ctx.fs.resolvePath(ctx.cwd, file);
            const content = await withDefenseContext("input file read", () =>
              ctx.fs.readFile(filePath)
            );
            const lines = content.split("\n");
            if (lines.length > 0 && lines[lines.length - 1] === "") {
              lines.pop();
            }
            fileDataList.push({ filename: file, lines });
          } catch (e) {
            if (e instanceof ExecutionLimitError) {
              throw e;
            }
            return {
              stdout: "",
              stderr: `awk: ${file}: No such file or directory\n`,
              exitCode: 1
            };
          }
        }
      } else {
        const lines = ctx.stdin.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }
        fileDataList.push({ filename: "", lines });
      }

      // Process each file
      for (const fileData of fileDataList) {
        runtimeCtx.FILENAME = fileData.filename;
        runtimeCtx.FNR = 0;
        runtimeCtx.lines = fileData.lines;
        runtimeCtx.lineIndex = -1;
        runtimeCtx.shouldNextFile = false;

        // Use while loop with lineIndex to support getline advancing the line
        while (runtimeCtx.lineIndex < fileData.lines.length - 1) {
          runtimeCtx.lineIndex++;
          const activeLineIndex = runtimeCtx.lineIndex;
          await withDefenseContext("line execution", () =>
            interp.executeLine(fileData.lines[activeLineIndex])
          );
          if (runtimeCtx.shouldExit || runtimeCtx.shouldNextFile) break;
        }

        if (runtimeCtx.shouldExit) break;
      }

      // Execute END blocks (always run, even after exit - AWK semantics)
      await withDefenseContext("END execution", () => interp.executeEnd());

      return {
        stdout: interp.getOutput(),
        stderr: "",
        exitCode: interp.getExitCode()
      };
    } catch (e) {
      if (e instanceof ExecutionLimitError) {
        throw e;
      }
      // Handle errors during execution
      const msg = e instanceof Error ? e.message : String(e);
      const exitCode =
        e instanceof ExecutionLimitError ? ExecutionLimitError.EXIT_CODE : 2;
      return {
        stdout: interp.getOutput(),
        stderr: `awk: ${msg}\n`,
        exitCode
      };
    }
  }
};

function processEscapes(str: string): string {
  return str
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\a/g, "\x07") // bell
    .replace(/\\v/g, "\v")
    .replace(/\\\\/g, "\\");
}

function createFieldSepRegex(
  sep: string
): import("../../regex/index.js").UserRegex {
  if (sep === " ") {
    return createUserRegex("\\s+");
  }

  const regexMetachars = /[[\](){}.*+?^$|\\]/;
  if (regexMetachars.test(sep)) {
    try {
      return createUserRegex(sep);
    } catch {
      return createUserRegex(escapeForRegex(sep));
    }
  }

  return createUserRegex(escapeForRegex(sep));
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "awk",
  flags: [
    { flag: "-F", type: "value", valueHint: "delimiter" },
    { flag: "-v", type: "value", valueHint: "string" }
  ],
  stdinType: "text",
  needsArgs: true
};
