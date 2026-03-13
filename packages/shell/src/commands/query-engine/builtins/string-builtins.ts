/**
 * String-related jq builtins
 *
 * Handles string manipulation functions like join, split, test, match, gsub, etc.
 */

import { createUserRegex } from "../../../regex/index";
import type { EvalContext } from "../evaluator";
import type { AstNode } from "../parser";
import type { QueryValue } from "../value-operations";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext
) => QueryValue[];

/**
 * Handle string builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a string builtin handled here.
 */
export function evalStringBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn
): QueryValue[] | null {
  switch (name) {
    case "join": {
      if (!Array.isArray(value)) return [null];
      const seps = args.length > 0 ? evaluate(value, args[0], ctx) : [""];
      // jq: null values become empty strings, others get stringified
      // Also check for arrays/objects which should error
      for (const x of value) {
        if (Array.isArray(x) || (x !== null && typeof x === "object")) {
          throw new Error("cannot join: contains arrays or objects");
        }
      }
      // Handle generator args - each separator produces its own output
      return seps.map((sep) =>
        value
          .map((x) => (x === null ? "" : typeof x === "string" ? x : String(x)))
          .join(String(sep))
      );
    }

    case "split": {
      if (typeof value !== "string" || args.length === 0) return [null];
      const seps = evaluate(value, args[0], ctx);
      const sep = String(seps[0]);
      return [value.split(sep)];
    }

    case "splits": {
      // Split string by regex, return each part as separate output
      if (typeof value !== "string" || args.length === 0) return [];
      const patterns = evaluate(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags =
          args.length > 1 ? String(evaluate(value, args[1], ctx)[0]) : "g";
        // Ensure global flag is set for split
        const regex = createUserRegex(
          pattern,
          flags.includes("g") ? flags : `${flags}g`
        );
        return regex.split(value);
      } catch {
        return [];
      }
    }

    case "scan": {
      // Find all regex matches in string
      if (typeof value !== "string" || args.length === 0) return [];
      const patterns = evaluate(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags =
          args.length > 1 ? String(evaluate(value, args[1], ctx)[0]) : "";
        // Ensure global flag is set for matchAll
        const regex = createUserRegex(
          pattern,
          flags.includes("g") ? flags : `${flags}g`
        );
        const matches = [...regex.matchAll(value)];
        // Return each match - if groups exist, return array of groups, else return match string
        return matches.map((m) => {
          if (m.length > 1) {
            // Has capture groups - return array of captured groups (excluding full match)
            return m.slice(1);
          }
          // No capture groups - return full match string
          return m[0];
        });
      } catch {
        return [];
      }
    }

    case "test": {
      if (typeof value !== "string" || args.length === 0) return [false];
      const patterns = evaluate(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags =
          args.length > 1 ? String(evaluate(value, args[1], ctx)[0]) : "";
        return [createUserRegex(pattern, flags).test(value)];
      } catch {
        return [false];
      }
    }

    case "match": {
      if (typeof value !== "string" || args.length === 0) return [null];
      const patterns = evaluate(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags =
          args.length > 1 ? String(evaluate(value, args[1], ctx)[0]) : "";
        const re = createUserRegex(pattern, `${flags}d`);
        const m = re.exec(value);
        if (!m) return [];
        const indices = (
          m as RegExpExecArray & { indices?: [number, number][] }
        ).indices;
        return [
          {
            offset: m.index,
            length: m[0].length,
            string: m[0],
            captures: m.slice(1).map((c, i) => {
              const captureIndices = indices?.[i + 1];
              return {
                offset: captureIndices?.[0] ?? null,
                length: c?.length ?? 0,
                string: c ?? "",
                name: null
              };
            })
          }
        ];
      } catch {
        return [null];
      }
    }

    case "capture": {
      if (typeof value !== "string" || args.length === 0) return [null];
      const patterns = evaluate(value, args[0], ctx);
      const pattern = String(patterns[0]);
      try {
        const flags =
          args.length > 1 ? String(evaluate(value, args[1], ctx)[0]) : "";
        const re = createUserRegex(pattern, flags);
        const m = re.match(value);
        if (!m || !m.groups) return [Object.create(null)];
        return [m.groups];
      } catch {
        return [null];
      }
    }

    case "sub": {
      if (typeof value !== "string" || args.length < 2) return [null];
      const patterns = evaluate(value, args[0], ctx);
      const replacements = evaluate(value, args[1], ctx);
      const pattern = String(patterns[0]);
      const replacement = String(replacements[0]);
      try {
        const flags =
          args.length > 2 ? String(evaluate(value, args[2], ctx)[0]) : "";
        return [createUserRegex(pattern, flags).replace(value, replacement)];
      } catch {
        return [value];
      }
    }

    case "gsub": {
      if (typeof value !== "string" || args.length < 2) return [null];
      const patterns = evaluate(value, args[0], ctx);
      const replacements = evaluate(value, args[1], ctx);
      const pattern = String(patterns[0]);
      const replacement = String(replacements[0]);
      try {
        const flags =
          args.length > 2 ? String(evaluate(value, args[2], ctx)[0]) : "g";
        const effectiveFlags = flags.includes("g") ? flags : `${flags}g`;
        return [
          createUserRegex(pattern, effectiveFlags).replace(value, replacement)
        ];
      } catch {
        return [value];
      }
    }

    case "ascii_downcase":
      if (typeof value === "string") {
        return [
          value.replace(/[A-Z]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) + 32)
          )
        ];
      }
      return [null];

    case "ascii_upcase":
      if (typeof value === "string") {
        return [
          value.replace(/[a-z]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 32)
          )
        ];
      }
      return [null];

    case "ltrimstr": {
      if (typeof value !== "string" || args.length === 0) return [value];
      const prefixes = evaluate(value, args[0], ctx);
      const prefix = String(prefixes[0]);
      return [value.startsWith(prefix) ? value.slice(prefix.length) : value];
    }

    case "rtrimstr": {
      if (typeof value !== "string" || args.length === 0) return [value];
      const suffixes = evaluate(value, args[0], ctx);
      const suffix = String(suffixes[0]);
      // Handle empty suffix case (slice(0, -0) = slice(0, 0) = "")
      if (suffix === "") return [value];
      return [value.endsWith(suffix) ? value.slice(0, -suffix.length) : value];
    }

    case "trimstr": {
      if (typeof value !== "string" || args.length === 0) return [value];
      const strs = evaluate(value, args[0], ctx);
      const str = String(strs[0]);
      if (str === "") return [value];
      let result = value;
      if (result.startsWith(str)) result = result.slice(str.length);
      if (result.endsWith(str)) result = result.slice(0, -str.length);
      return [result];
    }

    case "trim":
      if (typeof value === "string") return [value.trim()];
      throw new Error("trim input must be a string");

    case "ltrim":
      if (typeof value === "string") return [value.trimStart()];
      throw new Error("trim input must be a string");

    case "rtrim":
      if (typeof value === "string") return [value.trimEnd()];
      throw new Error("trim input must be a string");

    case "startswith": {
      if (typeof value !== "string" || args.length === 0) return [false];
      const prefixes = evaluate(value, args[0], ctx);
      return [value.startsWith(String(prefixes[0]))];
    }

    case "endswith": {
      if (typeof value !== "string" || args.length === 0) return [false];
      const suffixes = evaluate(value, args[0], ctx);
      return [value.endsWith(String(suffixes[0]))];
    }

    case "ascii":
      if (typeof value === "string" && value.length > 0) {
        return [value.charCodeAt(0)];
      }
      return [null];

    case "explode":
      if (typeof value === "string") {
        return [Array.from(value).map((c) => c.codePointAt(0))];
      }
      return [null];

    case "implode":
      if (!Array.isArray(value)) {
        throw new Error("implode input must be an array");
      }
      {
        // jq: Invalid code points get replaced with Unicode replacement character (0xFFFD)
        const REPLACEMENT_CHAR = 0xfffd;
        const chars = (value as QueryValue[]).map((cp) => {
          // Check for non-numeric values
          if (typeof cp === "string") {
            throw new Error(
              `string (${JSON.stringify(cp)}) can't be imploded, unicode codepoint needs to be numeric`
            );
          }
          if (typeof cp !== "number" || Number.isNaN(cp)) {
            throw new Error(
              `number (null) can't be imploded, unicode codepoint needs to be numeric`
            );
          }
          // Truncate to integer
          const code = Math.trunc(cp);
          // Check for valid Unicode code point
          // Valid range: 0 to 0x10FFFF, excluding surrogate pairs (0xD800-0xDFFF)
          if (code < 0 || code > 0x10ffff) {
            return String.fromCodePoint(REPLACEMENT_CHAR);
          }
          if (code >= 0xd800 && code <= 0xdfff) {
            return String.fromCodePoint(REPLACEMENT_CHAR);
          }
          return String.fromCodePoint(code);
        });
        return [chars.join("")];
      }

    default:
      return null;
  }
}
