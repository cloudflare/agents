/**
 * jq - Command-line JSON processor
 *
 * Full jq implementation with proper parser and evaluator.
 */

import { sanitizeErrorMessage } from "../../fs/sanitize-error";
import { ExecutionLimitError } from "../../interpreter/errors";
import type { Command, CommandContext, ExecResult } from "../../types";
import { readFiles } from "../../utils/file-reader";
import { hasHelpFlag, showHelp, unknownOption } from "../help";
import {
  type EvaluateOptions,
  evaluate,
  parse,
  type QueryValue
} from "../query-engine/index";
import { sanitizeParsedData } from "../query-engine/safe-object";

/**
 * Parse a JSON stream (concatenated JSON values).
 * Real jq can handle `{...}{...}` or `{...}\n{...}` or pretty-printed concatenated JSONs.
 */
function parseJsonStream(input: string): unknown[] {
  const results: unknown[] = [];
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && /\s/.test(input[pos])) pos++;
    if (pos >= len) break;

    const startPos = pos;
    const char = input[pos];

    if (char === "{" || char === "[") {
      // Parse object or array by finding matching close bracket
      const openBracket = char;
      const closeBracket = char === "{" ? "}" : "]";
      let depth = 1;
      let inString = false;
      let isEscaped = false;
      pos++;

      while (pos < len && depth > 0) {
        const c = input[pos];
        if (isEscaped) {
          isEscaped = false;
        } else if (c === "\\") {
          isEscaped = true;
        } else if (c === '"') {
          inString = !inString;
        } else if (!inString) {
          if (c === openBracket) depth++;
          else if (c === closeBracket) depth--;
        }
        pos++;
      }

      if (depth !== 0) {
        throw new Error(
          `Unexpected end of JSON input at position ${pos} (unclosed ${openBracket})`
        );
      }

      results.push(sanitizeParsedData(JSON.parse(input.slice(startPos, pos))));
    } else if (char === '"') {
      // Parse string
      let isEscaped = false;
      pos++;
      while (pos < len) {
        const c = input[pos];
        if (isEscaped) {
          isEscaped = false;
        } else if (c === "\\") {
          isEscaped = true;
        } else if (c === '"') {
          pos++;
          break;
        }
        pos++;
      }
      results.push(sanitizeParsedData(JSON.parse(input.slice(startPos, pos))));
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      // Parse number
      while (pos < len && /[\d.eE+-]/.test(input[pos])) pos++;
      results.push(sanitizeParsedData(JSON.parse(input.slice(startPos, pos))));
    } else if (input.slice(pos, pos + 4) === "true") {
      results.push(true);
      pos += 4;
    } else if (input.slice(pos, pos + 5) === "false") {
      results.push(false);
      pos += 5;
    } else if (input.slice(pos, pos + 4) === "null") {
      results.push(null);
      pos += 4;
    } else {
      // Try to provide context about what we found
      const context = input.slice(pos, pos + 10);
      throw new Error(
        `Invalid JSON at position ${startPos}: unexpected '${context.split(/\s/)[0]}'`
      );
    }
  }

  return results;
}

const jqHelp = {
  name: "jq",
  summary: "command-line JSON processor",
  usage: "jq [OPTIONS] FILTER [FILE]",
  options: [
    "-r, --raw-output  output strings without quotes",
    "-c, --compact     compact output (no pretty printing)",
    "-e, --exit-status set exit status based on output",
    "-s, --slurp       read entire input into array",
    "-n, --null-input  don't read any input",
    "-j, --join-output don't print newlines after each output",
    "-a, --ascii       force ASCII output",
    "-S, --sort-keys   sort object keys",
    "-C, --color       colorize output (ignored)",
    "-M, --monochrome  monochrome output (ignored)",
    "    --tab         use tabs for indentation",
    "    --help        display this help and exit"
  ]
};

function formatValue(
  v: QueryValue,
  compact: boolean,
  raw: boolean,
  sortKeys: boolean,
  useTab: boolean,
  indent = 0
): string {
  if (v === null) return "null";
  if (v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "null";
    return String(v);
  }
  if (typeof v === "string") return raw ? v : JSON.stringify(v);

  const indentStr = useTab ? "\t" : "  ";

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (compact) {
      return `[${v.map((x) => formatValue(x, true, false, sortKeys, useTab)).join(",")}]`;
    }
    const items = v.map(
      (x) =>
        indentStr.repeat(indent + 1) +
        formatValue(x, false, false, sortKeys, useTab, indent + 1)
    );
    return `[\n${items.join(",\n")}\n${indentStr.repeat(indent)}]`;
  }

  if (typeof v === "object") {
    let keys = Object.keys(v as object);
    if (sortKeys) keys = keys.sort();
    if (keys.length === 0) return "{}";
    if (compact) {
      // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
      return `{${keys.map((k) => `${JSON.stringify(k)}:${formatValue((v as Record<string, unknown>)[k], true, false, sortKeys, useTab)}`).join(",")}}`;
    }
    const items = keys.map((k) => {
      // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
      const val = formatValue(
        (v as Record<string, unknown>)[k],
        false,
        false,
        sortKeys,
        useTab,
        indent + 1
      );
      return `${indentStr.repeat(indent + 1)}${JSON.stringify(k)}: ${val}`;
    });
    return `{\n${items.join(",\n")}\n${indentStr.repeat(indent)}}`;
  }

  return String(v);
}

export const jqCommand: Command = {
  name: "jq",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const withDefenseContext = <T>(
      _phase: string,
      op: () => Promise<T>
    ): Promise<T> => op();

    if (hasHelpFlag(args)) return showHelp(jqHelp);

    let raw = false;
    let compact = false;
    let exitStatus = false;
    let slurp = false;
    let nullInput = false;
    let joinOutput = false;
    let sortKeys = false;
    let useTab = false;
    let filter = ".";
    let filterSet = false;
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-r" || a === "--raw-output") raw = true;
      else if (a === "-c" || a === "--compact-output") compact = true;
      else if (a === "-e" || a === "--exit-status") exitStatus = true;
      else if (a === "-s" || a === "--slurp") slurp = true;
      else if (a === "-n" || a === "--null-input") nullInput = true;
      else if (a === "-j" || a === "--join-output") joinOutput = true;
      else if (a === "-a" || a === "--ascii") {
        /* ignored */
      } else if (a === "-S" || a === "--sort-keys") sortKeys = true;
      else if (a === "-C" || a === "--color") {
        /* ignored */
      } else if (a === "-M" || a === "--monochrome") {
        /* ignored */
      } else if (a === "--tab") useTab = true;
      else if (a === "-") files.push("-");
      else if (a.startsWith("--")) return unknownOption("jq", a);
      else if (a.startsWith("-")) {
        for (const c of a.slice(1)) {
          if (c === "r") raw = true;
          else if (c === "c") compact = true;
          else if (c === "e") exitStatus = true;
          else if (c === "s") slurp = true;
          else if (c === "n") nullInput = true;
          else if (c === "j") joinOutput = true;
          else if (c === "a") {
            /* ignored */
          } else if (c === "S") sortKeys = true;
          else if (c === "C") {
            /* ignored */
          } else if (c === "M") {
            /* ignored */
          } else return unknownOption("jq", `-${c}`);
        }
      } else if (!filterSet) {
        filter = a;
        filterSet = true;
      } else {
        files.push(a);
      }
    }

    // Build list of inputs: stdin or files
    let inputs: { source: string; content: string }[] = [];
    if (nullInput) {
      // No input
    } else if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
      inputs.push({ source: "stdin", content: ctx.stdin });
    } else {
      // Read all files in parallel using shared utility
      const result = await withDefenseContext("file read", () =>
        readFiles(ctx, files, {
          cmdName: "jq",
          stopOnError: true
        })
      );
      if (result.exitCode !== 0) {
        return {
          stdout: "",
          stderr: result.stderr,
          exitCode: 2 // jq uses exit code 2 for file errors
        };
      }
      inputs = result.files.map((f) => ({
        source: f.filename || "stdin",
        content: f.content
      }));
    }

    try {
      const ast = parse(filter);
      let values: QueryValue[] = [];

      const evalOptions: EvaluateOptions = {
        limits: ctx.limits
          ? { maxIterations: ctx.limits.maxJqIterations }
          : undefined,
        env: ctx.env
      };

      if (nullInput) {
        values = evaluate(null, ast, evalOptions);
      } else if (slurp) {
        // Slurp mode: combine all inputs into single array
        // Use JSON stream parser to handle concatenated JSON (not just NDJSON)
        const items: QueryValue[] = [];
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (trimmed) {
            items.push(...parseJsonStream(trimmed));
          }
        }
        values = evaluate(items, ast, evalOptions);
      } else {
        // Process each input file separately
        // Use JSON stream parser to handle concatenated JSON (e.g., cat file1.json file2.json | jq .)
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (!trimmed) continue;

          const jsonValues = parseJsonStream(trimmed);
          for (const jsonValue of jsonValues) {
            values.push(...evaluate(jsonValue, ast, evalOptions));
          }
        }
      }

      const formatted = values.map((v) =>
        formatValue(v, compact, raw, sortKeys, useTab)
      );
      const separator = joinOutput ? "" : "\n";
      const output = formatted.join(separator);

      // Check output size against limit
      const maxStringLength = ctx.limits?.maxStringLength;
      if (
        maxStringLength !== undefined &&
        maxStringLength > 0 &&
        output.length > maxStringLength
      ) {
        throw new ExecutionLimitError(
          `jq: output size limit exceeded (${maxStringLength} bytes)`,
          "string_length"
        );
      }

      const exitCode =
        exitStatus &&
        (values.length === 0 ||
          values.every((v) => v === null || v === undefined || v === false))
          ? 1
          : 0;

      return {
        stdout: output ? (joinOutput ? output : `${output}\n`) : "",
        stderr: "",
        exitCode
      };
    } catch (e) {
      if (e instanceof ExecutionLimitError) {
        const message = sanitizeErrorMessage(e.message);
        return {
          stdout: "",
          stderr: `jq: ${message}\n`,
          exitCode: ExecutionLimitError.EXIT_CODE
        };
      }
      const msg = sanitizeErrorMessage((e as Error).message);
      if (msg.includes("Unknown function")) {
        return {
          stdout: "",
          stderr: `jq: error: ${msg}\n`,
          exitCode: 3
        };
      }
      return {
        stdout: "",
        stderr: `jq: parse error: ${msg}\n`,
        exitCode: 5
      };
    }
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "jq",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-j", type: "boolean" },
    { flag: "-S", type: "boolean" },
    { flag: "--tab", type: "boolean" }
  ],
  stdinType: "json",
  needsArgs: true
};
