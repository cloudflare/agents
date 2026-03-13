import type { Command, CommandContext, ExecResult } from "../../types";

/**
 * Process echo -e escape sequences
 */
function processEscapes(input: string): { output: string; stop: boolean } {
  let result = "";
  let i = 0;

  while (i < input.length) {
    if (input[i] === "\\") {
      if (i + 1 >= input.length) {
        result += "\\";
        break;
      }

      const next = input[i + 1];

      switch (next) {
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "n":
          result += "\n";
          i += 2;
          break;
        case "t":
          result += "\t";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "a":
          result += "\x07";
          i += 2;
          break;
        case "b":
          result += "\b";
          i += 2;
          break;
        case "f":
          result += "\f";
          i += 2;
          break;
        case "v":
          result += "\v";
          i += 2;
          break;
        case "e":
        case "E":
          result += "\x1b";
          i += 2;
          break;
        case "c":
          // \c stops output and suppresses trailing newline
          return { output: result, stop: true };
        case "0": {
          // \0NNN - octal (up to 3 digits after the 0)
          let octal = "";
          let j = i + 2;
          while (j < input.length && j < i + 5 && /[0-7]/.test(input[j])) {
            octal += input[j];
            j++;
          }
          if (octal.length === 0) {
            // \0 alone is NUL
            result += "\0";
          } else {
            const code = parseInt(octal, 8) % 256;
            result += String.fromCharCode(code);
          }
          i = j;
          break;
        }
        case "x": {
          // \xHH - hex (1-2 hex digits)
          let hex = "";
          let j = i + 2;
          while (
            j < input.length &&
            j < i + 4 &&
            /[0-9a-fA-F]/.test(input[j])
          ) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            // \x with no valid hex digits - output literally
            result += "\\x";
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            result += String.fromCharCode(code);
            i = j;
          }
          break;
        }
        case "u": {
          // \uHHHH - 4-digit unicode
          let hex = "";
          let j = i + 2;
          while (
            j < input.length &&
            j < i + 6 &&
            /[0-9a-fA-F]/.test(input[j])
          ) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            result += "\\u";
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            result += String.fromCodePoint(code);
            i = j;
          }
          break;
        }
        case "U": {
          // \UHHHHHHHH - 8-digit unicode
          let hex = "";
          let j = i + 2;
          while (
            j < input.length &&
            j < i + 10 &&
            /[0-9a-fA-F]/.test(input[j])
          ) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            result += "\\U";
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            try {
              result += String.fromCodePoint(code);
            } catch {
              // Invalid code point, output as-is
              result += `\\U${hex}`;
            }
            i = j;
          }
          break;
        }
        default:
          // Unknown escape - keep the backslash and character
          result += `\\${next}`;
          i += 2;
      }
    } else {
      result += input[i];
      i++;
    }
  }

  return { output: result, stop: false };
}

export const echoCommand: Command = {
  name: "echo",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let noNewline = false;
    // When xpg_echo is enabled, interpret escapes by default (like echo -e)
    let interpretEscapes = ctx.xpgEcho ?? false;
    let startIndex = 0;

    // Parse flags
    while (startIndex < args.length) {
      const arg = args[startIndex];
      if (arg === "-n") {
        noNewline = true;
        startIndex++;
      } else if (arg === "-e") {
        interpretEscapes = true;
        startIndex++;
      } else if (arg === "-E") {
        interpretEscapes = false;
        startIndex++;
      } else if (arg === "-ne" || arg === "-en") {
        noNewline = true;
        interpretEscapes = true;
        startIndex++;
      } else {
        break;
      }
    }

    let output = args.slice(startIndex).join(" ");

    if (interpretEscapes) {
      const result = processEscapes(output);
      output = result.output;
      if (result.stop) {
        // \c encountered - suppress newline and stop
        return {
          stdout: output,
          stderr: "",
          exitCode: 0
        };
      }
    }

    if (!noNewline) {
      output += "\n";
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "echo",
  flags: [
    { flag: "-n", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-E", type: "boolean" }
  ],
  stdinType: "none",
  needsArgs: true
};
