/**
 * od - dump files in octal and other formats
 *
 * Usage: od [OPTION]... [FILE]...
 *
 * Write an unambiguous representation, octal bytes by default,
 * of FILE to standard output.
 */

import type { Command, CommandContext, ExecResult } from "../../types";

type OutputFormat = "octal" | "hex" | "char";

async function odExecute(
  args: string[],
  ctx: CommandContext
): Promise<ExecResult> {
  // Parse options
  let addressMode: "octal" | "none" = "octal";
  const outputFormats: OutputFormat[] = [];
  const fileArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c") {
      outputFormats.push("char");
    } else if (arg === "-An" || (arg === "-A" && args[i + 1] === "n")) {
      addressMode = "none";
      if (arg === "-A") i++; // Skip the "n" argument
    } else if (arg === "-t" && args[i + 1]) {
      const format = args[++i];
      if (format === "x1") {
        outputFormats.push("hex");
      } else if (format === "c") {
        outputFormats.push("char");
      } else if (format.startsWith("o")) {
        outputFormats.push("octal");
      }
    } else if (!arg.startsWith("-") || arg === "-") {
      fileArgs.push(arg);
    }
  }

  // Default to octal if no format specified
  if (outputFormats.length === 0) {
    outputFormats.push("octal");
  }

  // Get input - from file or stdin
  let input = ctx.stdin;

  // Check for file argument
  if (fileArgs.length > 0 && fileArgs[0] !== "-") {
    const filePath = fileArgs[0].startsWith("/")
      ? fileArgs[0]
      : `${ctx.cwd}/${fileArgs[0]}`;
    try {
      input = await ctx.fs.readFile(filePath);
    } catch {
      return {
        stdout: "",
        stderr: `od: ${fileArgs[0]}: No such file or directory\n`,
        exitCode: 1
      };
    }
  }

  // Check if char format is included (affects field width)
  const hasCharFormat = outputFormats.includes("char");

  // Format a single byte for character mode (4-char field, right-aligned)
  // Real od uses backslash only for named escape sequences, not for generic octal
  function formatCharByte(code: number): string {
    // Named escape sequences (2 chars, padded with 2 leading spaces)
    if (code === 0) return "  \\0";
    if (code === 7) return "  \\a";
    if (code === 8) return "  \\b";
    if (code === 9) return "  \\t";
    if (code === 10) return "  \\n";
    if (code === 11) return "  \\v";
    if (code === 12) return "  \\f";
    if (code === 13) return "  \\r";
    if (code >= 32 && code < 127) {
      // Printable ASCII - 3 leading spaces + char = 4 chars total
      return `   ${String.fromCharCode(code)}`;
    }
    // Non-printable - use 3-digit octal WITHOUT backslash (this is real od behavior)
    return ` ${code.toString(8).padStart(3, "0")}`;
  }

  // Format a single byte for hex mode
  // Field width depends on whether char format is also used
  function formatHexByte(code: number): string {
    if (hasCharFormat) {
      // 4-char field: 2 spaces + 2 hex digits
      return `  ${code.toString(16).padStart(2, "0")}`;
    }
    // 3-char field: 1 space + 2 hex digits
    return ` ${code.toString(16).padStart(2, "0")}`;
  }

  // Format a single byte for octal mode (right-aligned)
  function formatOctalByte(code: number): string {
    return ` ${code.toString(8).padStart(3, "0")}`;
  }

  // Get bytes from input
  const bytes: number[] = [];
  for (const char of input) {
    bytes.push(char.charCodeAt(0));
  }

  // Determine bytes per line (use 16 for hex/char compatibility)
  const bytesPerLine = 16;

  // Build output lines
  const lines: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const chunkBytes = bytes.slice(offset, offset + bytesPerLine);

    // For each output format, generate a line
    for (let formatIdx = 0; formatIdx < outputFormats.length; formatIdx++) {
      const format = outputFormats[formatIdx];
      let formatted: string[];

      if (format === "char") {
        formatted = chunkBytes.map(formatCharByte);
      } else if (format === "hex") {
        formatted = chunkBytes.map(formatHexByte);
      } else {
        formatted = chunkBytes.map(formatOctalByte);
      }

      // Add address prefix only for the first format of each offset
      let prefix = "";
      if (formatIdx === 0 && addressMode !== "none") {
        prefix = `${offset.toString(8).padStart(7, "0")} `;
      } else if (formatIdx > 0 || addressMode === "none") {
        // For subsequent formats or no-address mode, just use spaces
        prefix = addressMode === "none" ? "" : "        ";
      }

      // No separator needed - each field already includes leading spaces
      lines.push(prefix + formatted.join(""));
    }
  }

  // Add final address
  if (addressMode !== "none" && bytes.length > 0) {
    lines.push(bytes.length.toString(8).padStart(7, "0"));
  }

  return {
    stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    stderr: "",
    exitCode: 0
  };
}

export const od: Command = {
  name: "od",
  execute: odExecute
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "od",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-A", type: "value", valueHint: "string" },
    { flag: "-t", type: "value", valueHint: "string" },
    { flag: "-N", type: "value", valueHint: "number" }
  ],
  stdinType: "text",
  needsFiles: true
};
