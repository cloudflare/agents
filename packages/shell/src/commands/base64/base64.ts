/**
 * base64 - Encode or decode base64
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const base64Help = {
  name: "base64",
  summary: "base64 encode/decode data and print to standard output",
  usage: "base64 [OPTION]... [FILE]",
  options: [
    "-d, --decode    decode data",
    "-w, --wrap=COLS wrap encoded lines after COLS character (default 76, 0 to disable)",
    "    --help      display this help and exit"
  ]
};

const argDefs = {
  decode: { short: "d", long: "decode", type: "boolean" as const },
  wrap: { short: "w", long: "wrap", type: "number" as const, default: 76 }
};

// Helper to read file as binary
async function readBinary(
  ctx: CommandContext,
  files: string[],
  cmdName: string
): Promise<{ ok: true; data: Uint8Array } | { ok: false; error: ExecResult }> {
  // No files - read from stdin
  if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
    // Convert binary string directly to bytes without UTF-8 re-encoding
    return {
      ok: true,
      data: Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0))
    };
  }

  // Read and concatenate all files as binary
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    if (file === "-") {
      // Convert binary string directly to bytes without UTF-8 re-encoding
      chunks.push(Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0)));
      continue;
    }
    try {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      const data = await ctx.fs.readFileBuffer(filePath);
      chunks.push(data);
    } catch {
      return {
        ok: false,
        error: {
          stdout: "",
          stderr: `${cmdName}: ${file}: No such file or directory\n`,
          exitCode: 1
        }
      };
    }
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return { ok: true, data: result };
}

export const base64Command: Command = {
  name: "base64",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(base64Help);
    }

    const parsed = parseArgs("base64", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const decode = parsed.result.flags.decode;
    const wrapCols = parsed.result.flags.wrap;
    const files = parsed.result.positional;

    try {
      if (decode) {
        // For decoding, read as text and strip whitespace
        const readResult = await readBinary(ctx, files, "base64");
        if (!readResult.ok) return readResult.error;

        // Use Buffer if available (Node.js) for better large file handling
        if (typeof Buffer !== "undefined") {
          const buffer = Buffer.from(readResult.data);
          const cleaned = buffer.toString("utf8").replace(/\s/g, "");
          const decoded = Buffer.from(cleaned, "base64");
          // Convert to binary string (each char code = byte value)
          // Use Buffer's latin1 encoding which treats each byte as a character
          const result = decoded.toString("latin1");
          return {
            stdout: result,
            stderr: "",
            exitCode: 0,
            stdoutEncoding: "binary"
          };
        }

        // Browser fallback - use binary string (latin1) to preserve bytes for input
        const input = String.fromCharCode(...readResult.data);
        const cleaned = input.replace(/\s/g, "");
        // Decode base64 to binary string (each char code = byte value)
        const decoded = atob(cleaned);
        return {
          stdout: decoded,
          stderr: "",
          exitCode: 0,
          stdoutEncoding: "binary"
        };
      }

      // Encoding: read as binary
      const readResult = await readBinary(ctx, files, "base64");
      if (!readResult.ok) return readResult.error;

      // Use Buffer if available (Node.js) for better large file handling
      let encoded: string;
      if (typeof Buffer !== "undefined") {
        const buffer = Buffer.from(readResult.data);
        encoded = buffer.toString("base64");
      } else {
        // Browser fallback - convert binary to base64
        encoded = btoa(String.fromCharCode(...readResult.data));
      }

      if (wrapCols > 0) {
        const lines: string[] = [];
        for (let i = 0; i < encoded.length; i += wrapCols) {
          lines.push(encoded.slice(i, i + wrapCols));
        }
        encoded = lines.join("\n") + (encoded.length > 0 ? "\n" : "");
      }
      return { stdout: encoded, stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: "base64: invalid input\n", exitCode: 1 };
    }
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "base64",
  flags: [
    { flag: "-d", type: "boolean" },
    { flag: "-w", type: "value", valueHint: "number" }
  ],
  stdinType: "text",
  needsFiles: true
};
