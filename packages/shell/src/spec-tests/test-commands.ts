/**
 * Test helper commands for spec tests
 * These replace the Python scripts used in the original Oil shell tests
 *
 * NOTE: Standard Unix commands (tac, od, hostname) are now in src/commands/
 */

import { defineCommand } from "../custom-commands";
import type { Command } from "../types";

// argv.py - prints arguments in Python 2 repr() format: ['arg1', "arg with '"]
// Python uses single quotes by default, double quotes when string contains single quotes
// Python 2 escapes non-printable and non-ASCII bytes as \xNN
export const argvCommand: Command = defineCommand("argv.py", async (args) => {
  const formatted = args.map((arg) => {
    // Convert string to Python 2 repr() format
    // Process character by character, escaping as needed
    let escaped = "";
    for (let i = 0; i < arg.length; i++) {
      const char = arg[i];
      const code = arg.charCodeAt(i);

      if (char === "\\") {
        escaped += "\\\\";
      } else if (char === "\n") {
        escaped += "\\n";
      } else if (char === "\r") {
        escaped += "\\r";
      } else if (char === "\t") {
        escaped += "\\t";
      } else if (code < 0x20 || code === 0x7f) {
        // Non-printable ASCII control characters -> \xNN
        escaped += `\\x${code.toString(16).padStart(2, "0")}`;
      } else if (code >= 0x80 && code <= 0xff) {
        // Latin-1 range (U+0080-U+00FF): show as single \xNN
        // This matches Python 2 behavior where bytes are 1:1 with codepoints
        escaped += `\\x${code.toString(16).padStart(2, "0")}`;
      } else if (code >= 0x100) {
        // Non-Latin-1 Unicode: encode as UTF-8 bytes, then escape each byte as \xNN
        // This matches Python 2 behavior with byte strings
        const encoder = new TextEncoder();
        const bytes = encoder.encode(char);
        for (const byte of bytes) {
          escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
        }
      } else {
        // Printable ASCII
        escaped += char;
      }
    }

    const hasSingleQuote = arg.includes("'");
    const hasDoubleQuote = arg.includes('"');

    if (hasSingleQuote && !hasDoubleQuote) {
      // Use double quotes when string contains single quotes but no double quotes
      return `"${escaped}"`;
    }
    // Default: use single quotes (escape single quotes)
    escaped = escaped.replace(/'/g, "\\'");
    return `'${escaped}'`;
  });
  return { stdout: `[${formatted.join(", ")}]\n`, stderr: "", exitCode: 0 };
});

// printenv.py - prints environment variable values, one per line
// Prints "None" for variables that are not set (matching Python's printenv.py)
// Uses exportedEnv (only exported variables) to match bash behavior
export const printenvCommand: Command = defineCommand(
  "printenv.py",
  async (args, ctx) => {
    // Use exportedEnv if available (only exported vars), fall back to full env
    const env = ctx.exportedEnv || ctx.env;
    const output = args
      .map((name) => {
        const value = env instanceof Map ? env.get(name) : env[name];
        return value ?? "None";
      })
      .join("\n");
    return {
      stdout: output ? `${output}\n` : "",
      stderr: "",
      exitCode: 0
    };
  }
);

// stdout_stderr.py - outputs to both stdout and stderr
// If an argument is provided, it outputs that to stdout instead of "STDOUT"
export const stdoutStderrCommand: Command = defineCommand(
  "stdout_stderr.py",
  async (args) => {
    const stdout = args.length > 0 ? `${args[0]}\n` : "STDOUT\n";
    return { stdout, stderr: "STDERR\n", exitCode: 0 };
  }
);

// read_from_fd.py - reads from specified file descriptors
// Arguments are FD numbers. For each FD, outputs "<fd>: <content>" (without trailing newline from content)
export const readFromFdCommand: Command = defineCommand(
  "read_from_fd.py",
  async (args, ctx) => {
    const results: string[] = [];

    for (const arg of args) {
      const fd = Number.parseInt(arg, 10);
      if (Number.isNaN(fd)) {
        continue;
      }

      let content = "";
      if (fd === 0) {
        // FD 0 is stdin
        content = ctx.stdin || "";
      } else if (ctx.fileDescriptors) {
        // Other FDs from the fileDescriptors map
        content = ctx.fileDescriptors.get(fd) || "";
      }

      // Remove trailing newline from content for the output format
      const trimmedContent = content.replace(/\n$/, "");
      results.push(`${fd}: ${trimmedContent}`);
    }

    return {
      stdout: results.length > 0 ? `${results.join("\n")}\n` : "",
      stderr: "",
      exitCode: 0
    };
  }
);

/** All test helper commands (Python script replacements) */
export const testHelperCommands: Command[] = [
  argvCommand,
  printenvCommand,
  stdoutStderrCommand,
  readFromFdCommand
];
