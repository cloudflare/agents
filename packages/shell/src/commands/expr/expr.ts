import { sanitizeErrorMessage } from "../../fs/sanitize-error";
import { createUserRegex } from "../../regex/index";
import type { Command, CommandContext, ExecResult } from "../../types";

/**
 * expr - evaluate expressions
 *
 * Basic implementation supporting arithmetic operations and string operations.
 */
export const exprCommand: Command = {
  name: "expr",

  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "expr: missing operand\n",
        exitCode: 2
      };
    }

    try {
      const result = evaluateExpr(args);
      // expr returns 1 if result is 0 or empty, 0 otherwise
      const exitCode = result === "0" || result === "" ? 1 : 0;
      return {
        stdout: `${result}\n`,
        stderr: "",
        exitCode
      };
    } catch (error) {
      const message = sanitizeErrorMessage((error as Error).message);
      return {
        stdout: "",
        stderr: `expr: ${message}\n`,
        exitCode: 2
      };
    }
  }
};

function evaluateExpr(args: string[]): string {
  // Simple single operand case
  if (args.length === 1) {
    return args[0];
  }

  // Join and parse expression
  // Handle basic arithmetic: +, -, *, /, %
  // Handle comparison: =, !=, <, >, <=, >=
  // Handle string operations: :, match, substr, index, length

  let i = 0;

  function parseOr(): string {
    let left = parseAnd();
    while (i < args.length && args[i] === "|") {
      i++;
      const right = parseAnd();
      // OR: returns left if non-zero/non-empty, else right
      if (left !== "0" && left !== "") {
        return left;
      }
      left = right;
    }
    return left;
  }

  function parseAnd(): string {
    let left = parseComparison();
    while (i < args.length && args[i] === "&") {
      i++;
      const right = parseComparison();
      // AND: returns left if both non-zero/non-empty, else 0
      if (left === "0" || left === "" || right === "0" || right === "") {
        left = "0";
      }
      // keep left as is if both are truthy
    }
    return left;
  }

  function parseComparison(): string {
    let left = parseAddSub();
    while (i < args.length) {
      const op = args[i];
      if (["=", "!=", "<", ">", "<=", ">="].includes(op)) {
        i++;
        const right = parseAddSub();
        const leftNum = parseInt(left, 10);
        const rightNum = parseInt(right, 10);
        const isNumeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);

        let result: boolean;
        if (op === "=") {
          result = isNumeric ? leftNum === rightNum : left === right;
        } else if (op === "!=") {
          result = isNumeric ? leftNum !== rightNum : left !== right;
        } else if (op === "<") {
          result = isNumeric ? leftNum < rightNum : left < right;
        } else if (op === ">") {
          result = isNumeric ? leftNum > rightNum : left > right;
        } else if (op === "<=") {
          result = isNumeric ? leftNum <= rightNum : left <= right;
        } else {
          result = isNumeric ? leftNum >= rightNum : left >= right;
        }
        left = result ? "1" : "0";
      } else {
        break;
      }
    }
    return left;
  }

  function parseAddSub(): string {
    let left = parseMulDiv();
    while (i < args.length) {
      const op = args[i];
      if (op === "+" || op === "-") {
        i++;
        const right = parseMulDiv();
        const leftNum = parseInt(left, 10);
        const rightNum = parseInt(right, 10);
        if (Number.isNaN(leftNum) || Number.isNaN(rightNum)) {
          throw new Error("non-integer argument");
        }
        left = String(op === "+" ? leftNum + rightNum : leftNum - rightNum);
      } else {
        break;
      }
    }
    return left;
  }

  function parseMulDiv(): string {
    let left = parseMatch();
    while (i < args.length) {
      const op = args[i];
      if (op === "*" || op === "/" || op === "%") {
        i++;
        const right = parseMatch();
        const leftNum = parseInt(left, 10);
        const rightNum = parseInt(right, 10);
        if (Number.isNaN(leftNum) || Number.isNaN(rightNum)) {
          throw new Error("non-integer argument");
        }
        if ((op === "/" || op === "%") && rightNum === 0) {
          throw new Error("division by zero");
        }
        if (op === "*") {
          left = String(leftNum * rightNum);
        } else if (op === "/") {
          left = String(Math.trunc(leftNum / rightNum));
        } else {
          left = String(leftNum % rightNum);
        }
      } else {
        break;
      }
    }
    return left;
  }

  function parseMatch(): string {
    let left = parsePrimary();
    while (i < args.length && args[i] === ":") {
      i++;
      const pattern = parsePrimary();
      // Match from beginning of string
      const regex = createUserRegex(`^${pattern}`);
      const match = regex.match(left);
      if (match) {
        // If pattern has capturing group, return the captured string
        // Otherwise return length of match
        left = match[1] !== undefined ? match[1] : String(match[0].length);
      } else {
        left = "0";
      }
    }
    return left;
  }

  function parsePrimary(): string {
    if (i >= args.length) {
      throw new Error("syntax error");
    }

    const token = args[i];

    // Handle string functions
    if (token === "match") {
      i++;
      const str = parsePrimary();
      const pattern = parsePrimary();
      const regex = createUserRegex(pattern);
      const match = regex.match(str);
      if (match) {
        return match[1] !== undefined ? match[1] : String(match[0].length);
      }
      return "0";
    }

    if (token === "substr") {
      i++;
      const str = parsePrimary();
      const pos = parseInt(parsePrimary(), 10);
      const len = parseInt(parsePrimary(), 10);
      if (Number.isNaN(pos) || Number.isNaN(len)) {
        throw new Error("non-integer argument");
      }
      // expr uses 1-based indexing
      return str.substring(pos - 1, pos - 1 + len);
    }

    if (token === "index") {
      i++;
      const str = parsePrimary();
      const chars = parsePrimary();
      // Find first char from chars in str
      for (let j = 0; j < str.length; j++) {
        if (chars.includes(str[j])) {
          return String(j + 1); // 1-based
        }
      }
      return "0";
    }

    if (token === "length") {
      i++;
      const str = parsePrimary();
      return String(str.length);
    }

    if (token === "(") {
      i++;
      const result = parseOr();
      if (i >= args.length || args[i] !== ")") {
        throw new Error("syntax error");
      }
      i++;
      return result;
    }

    i++;
    return token;
  }

  return parseOr();
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "expr",
  flags: [],
  needsArgs: true
};
