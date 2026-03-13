/**
 * strings - print the sequences of printable characters in files
 *
 * Usage: strings [OPTION]... [FILE]...
 *
 * For each FILE, print the printable character sequences that are at least
 * MIN characters long. If no FILE is specified, standard input is read.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const stringsHelp = {
  name: "strings",
  summary: "print the sequences of printable characters in files",
  usage: "strings [OPTION]... [FILE]...",
  description:
    "For each FILE, print the printable character sequences that are at least MIN characters long. If no FILE is specified, standard input is read.",
  options: [
    "-n MIN       Print sequences of at least MIN characters (default: 4)",
    "-t FORMAT    Print offset before each string (o=octal, x=hex, d=decimal)",
    "-a           Scan the entire file (default behavior)",
    "-e ENCODING  Select character encoding (s=7-bit, S=8-bit)"
  ],
  examples: [
    "strings file.bin          # Extract strings (min 4 chars)",
    "strings -n 8 file.bin     # Extract strings (min 8 chars)",
    "strings -t x file.bin     # Show hex offset",
    "echo 'hello' | strings    # Read from stdin"
  ]
};

type OffsetFormat = "o" | "x" | "d" | null;

interface StringsOptions {
  minLength: number;
  offsetFormat: OffsetFormat;
}

/**
 * Check if a byte represents a printable ASCII character.
 * Printable range: 32 (space) to 126 (~), plus tab (9) and newline (10)
 */
function isPrintable(byte: number): boolean {
  return (byte >= 32 && byte <= 126) || byte === 9;
}

/**
 * Format an offset according to the specified format.
 */
function formatOffset(offset: number, format: OffsetFormat): string {
  if (format === null) {
    return "";
  }
  switch (format) {
    case "o":
      return `${offset.toString(8).padStart(7, " ")} `;
    case "x":
      return `${offset.toString(16).padStart(7, " ")} `;
    case "d":
      return `${offset.toString(10).padStart(7, " ")} `;
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

/**
 * Extract printable strings from binary data.
 */
function extractStrings(
  data: Uint8Array | string,
  options: StringsOptions
): string[] {
  const results: string[] = [];
  let currentString = "";
  let stringStart = 0;

  // Convert string to bytes if needed
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];

    if (isPrintable(byte)) {
      if (currentString.length === 0) {
        stringStart = i;
      }
      currentString += String.fromCharCode(byte);
    } else {
      if (currentString.length >= options.minLength) {
        const prefix = formatOffset(stringStart, options.offsetFormat);
        results.push(`${prefix}${currentString}`);
      }
      currentString = "";
    }
  }

  // Handle string at end of data
  if (currentString.length >= options.minLength) {
    const prefix = formatOffset(stringStart, options.offsetFormat);
    results.push(`${prefix}${currentString}`);
  }

  return results;
}

export const strings: Command = {
  name: "strings",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(stringsHelp);
    }

    const options: StringsOptions = {
      minLength: 4,
      offsetFormat: null
    };

    const files: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      if (arg === "-n" && i + 1 < args.length) {
        const min = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(min) || min < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid minimum string length: '${args[i + 1]}'\n`
          };
        }
        options.minLength = min;
        i += 2;
      } else if (arg.match(/^-n\d+$/)) {
        const min = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(min) || min < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid minimum string length: '${arg.slice(2)}'\n`
          };
        }
        options.minLength = min;
        i++;
      } else if (arg.match(/^-\d+$/)) {
        // Handle -N shorthand (e.g., -8, -10)
        const min = Number.parseInt(arg.slice(1), 10);
        if (Number.isNaN(min) || min < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid minimum string length: '${arg.slice(1)}'\n`
          };
        }
        options.minLength = min;
        i++;
      } else if (arg === "-t" && i + 1 < args.length) {
        const format = args[i + 1];
        if (format !== "o" && format !== "x" && format !== "d") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid radix: '${format}'\n`
          };
        }
        options.offsetFormat = format;
        i += 2;
      } else if (arg.startsWith("-t") && arg.length === 3) {
        const format = arg[2];
        if (format !== "o" && format !== "x" && format !== "d") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid radix: '${format}'\n`
          };
        }
        options.offsetFormat = format as OffsetFormat;
        i++;
      } else if (arg === "-a" || arg === "--all" || arg === "-") {
        // -a scans entire file (default behavior)
        // - means stdin
        if (arg === "-") {
          files.push(arg);
        }
        i++;
      } else if (arg === "-e" && i + 1 < args.length) {
        // Encoding option - we only support s (7-bit) and S (8-bit) which are similar for ASCII
        const encoding = args[i + 1];
        if (encoding !== "s" && encoding !== "S") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid encoding: '${encoding}'\n`
          };
        }
        // We treat both the same for simplicity
        i += 2;
      } else if (arg.startsWith("-e") && arg.length === 3) {
        const encoding = arg[2];
        if (encoding !== "s" && encoding !== "S") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `strings: invalid encoding: '${encoding}'\n`
          };
        }
        i++;
      } else if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("strings", arg);
      } else {
        files.push(arg);
        i++;
      }
    }

    let output = "";

    if (files.length === 0) {
      // Read from stdin
      const input = ctx.stdin ?? "";
      const strings = extractStrings(input, options);
      output = strings.length > 0 ? `${strings.join("\n")}\n` : "";
    } else {
      // Process each file
      for (const file of files) {
        let content: string | null;
        if (file === "-") {
          content = ctx.stdin ?? "";
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          content = await ctx.fs.readFile(filePath);
          if (content === null) {
            return {
              exitCode: 1,
              stdout: output,
              stderr: `strings: ${file}: No such file or directory\n`
            };
          }
        }
        const strings = extractStrings(content, options);
        if (strings.length > 0) {
          output += `${strings.join("\n")}\n`;
        }
      }
    }

    return {
      exitCode: 0,
      stdout: output,
      stderr: ""
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "strings",
  flags: [
    { flag: "-n", type: "value", valueHint: "number" },
    { flag: "-t", type: "value", valueHint: "string" },
    { flag: "-a", type: "boolean" },
    { flag: "-e", type: "value", valueHint: "string" }
  ],
  stdinType: "text",
  needsFiles: true
};
