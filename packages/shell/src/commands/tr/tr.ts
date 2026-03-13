import { sanitizeErrorMessage } from "../../fs/sanitize-error";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const trHelp = {
  name: "tr",
  summary: "translate or delete characters",
  usage: "tr [OPTION]... SET1 [SET2]",
  options: [
    "-c, -C, --complement   use the complement of SET1",
    "-d, --delete           delete characters in SET1",
    "-s, --squeeze-repeats  squeeze repeated characters",
    "    --help             display this help and exit"
  ],
  description: `SET syntax:
  a-z         character range
  [:alnum:]   all letters and digits
  [:alpha:]   all letters
  [:digit:]   all digits
  [:lower:]   all lowercase letters
  [:upper:]   all uppercase letters
  [:space:]   all whitespace
  [:blank:]   horizontal whitespace
  [:punct:]   all punctuation
  [:print:]   all printable characters
  [:graph:]   all printable characters except space
  [:cntrl:]   all control characters
  [:xdigit:]  all hexadecimal digits
  \\n, \\t, \\r  escape sequences`
};

// POSIX character class definitions (Map prevents prototype pollution)
const POSIX_CLASSES = new Map<string, string>([
  [
    "[:alnum:]",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  ],
  ["[:alpha:]", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"],
  ["[:blank:]", " \t"],
  [
    "[:cntrl:]",
    Array.from({ length: 32 }, (_, i) => String.fromCharCode(i))
      .join("")
      .concat(String.fromCharCode(127))
  ],
  ["[:digit:]", "0123456789"],
  [
    "[:graph:]",
    Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join("")
  ],
  ["[:lower:]", "abcdefghijklmnopqrstuvwxyz"],
  [
    "[:print:]",
    Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("")
  ],
  ["[:punct:]", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
  ["[:space:]", " \t\n\r\f\v"],
  ["[:upper:]", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  ["[:xdigit:]", "0123456789ABCDEFabcdef"]
]);

function expandRange(set: string): string {
  let result = "";
  let i = 0;

  while (i < set.length) {
    // Check for POSIX character classes like [:alnum:]
    if (set[i] === "[" && set[i + 1] === ":") {
      let found = false;
      for (const [className, chars] of POSIX_CLASSES) {
        if (set.slice(i).startsWith(className)) {
          result += chars;
          i += className.length;
          found = true;
          break;
        }
      }
      if (found) continue;
    }

    // Handle escape sequences
    if (set[i] === "\\" && i + 1 < set.length) {
      const next = set[i + 1];
      if (next === "n") {
        result += "\n";
      } else if (next === "t") {
        result += "\t";
      } else if (next === "r") {
        result += "\r";
      } else {
        result += next;
      }
      i += 2;
      continue;
    }

    // Handle character ranges like a-z
    if (i + 2 < set.length && set[i + 1] === "-") {
      const start = set.charCodeAt(i);
      const end = set.charCodeAt(i + 2);
      if (end - start > 65536) {
        // Prevent memory exhaustion from huge character ranges
        throw new Error(
          `tr: character range too large: '${set[i]}-${set[i + 2]}'`
        );
      }
      for (let code = start; code <= end; code++) {
        result += String.fromCharCode(code);
      }
      i += 3;
      continue;
    }

    result += set[i];
    i++;
  }

  return result;
}

const argDefs = {
  complement: { short: "c", long: "complement", type: "boolean" as const },
  complementUpper: { short: "C", type: "boolean" as const },
  delete: { short: "d", long: "delete", type: "boolean" as const },
  squeeze: { short: "s", long: "squeeze-repeats", type: "boolean" as const }
};

export const trCommand: Command = {
  name: "tr",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(trHelp);
    }

    const parsed = parseArgs("tr", args, argDefs);
    if (!parsed.ok) return parsed.error;

    // -c and -C both enable complement mode
    const complementMode =
      parsed.result.flags.complement || parsed.result.flags.complementUpper;
    const deleteMode = parsed.result.flags.delete;
    const squeezeMode = parsed.result.flags.squeeze;
    const sets = parsed.result.positional;

    if (sets.length < 1) {
      return {
        stdout: "",
        stderr: "tr: missing operand\n",
        exitCode: 1
      };
    }

    if (!deleteMode && !squeezeMode && sets.length < 2) {
      return {
        stdout: "",
        stderr: "tr: missing operand after SET1\n",
        exitCode: 1
      };
    }

    let set1Raw: string;
    let set2: string;
    try {
      set1Raw = expandRange(sets[0]);
      set2 = sets.length > 1 ? expandRange(sets[1]) : "";
    } catch (e) {
      const message = sanitizeErrorMessage((e as Error).message);
      return {
        stdout: "",
        stderr: `${message}\n`,
        exitCode: 1
      };
    }
    const content = ctx.stdin;

    // Helper to check if character is in set1 (considering complement mode)
    const isInSet1 = (char: string): boolean => {
      const inSet = set1Raw.includes(char);
      return complementMode ? !inSet : inSet;
    };

    let output = "";

    if (deleteMode) {
      // Delete characters in set1 (or complement of set1)
      for (const char of content) {
        if (!isInSet1(char)) {
          output += char;
        }
      }
    } else if (squeezeMode && sets.length === 1) {
      // Squeeze consecutive characters in set1
      let prev = "";
      for (const char of content) {
        if (isInSet1(char) && char === prev) {
          continue; // Skip repeated character
        }
        output += char;
        prev = char;
      }
    } else {
      // Translate characters from set1 to set2
      if (complementMode) {
        // In complement mode, all characters NOT in set1 are translated
        // They're all mapped to a single character (last char of set2)
        const targetChar = set2.length > 0 ? set2[set2.length - 1] : "";
        for (const char of content) {
          if (!set1Raw.includes(char)) {
            output += targetChar;
          } else {
            output += char;
          }
        }
      } else {
        // Normal translation mode
        const translationMap = new Map<string, string>();
        for (let i = 0; i < set1Raw.length; i++) {
          // If set2 is shorter, use the last character of set2
          const targetChar = i < set2.length ? set2[i] : set2[set2.length - 1];
          translationMap.set(set1Raw[i], targetChar);
        }

        for (const char of content) {
          output += translationMap.get(char) ?? char;
        }
      }

      // If squeeze mode is also enabled, squeeze set2 characters
      if (squeezeMode) {
        let squeezed = "";
        let prev = "";
        for (const char of output) {
          if (set2.includes(char) && char === prev) {
            continue;
          }
          squeezed += char;
          prev = char;
        }
        output = squeezed;
      }
    }

    return { stdout: output, stderr: "", exitCode: 0 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tr",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-C", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-s", type: "boolean" }
  ],
  stdinType: "text",
  needsArgs: true
};
