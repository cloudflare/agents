import type { Command, ExecResult } from "../../types";

/**
 * seq - print a sequence of numbers
 *
 * Usage:
 *   seq LAST           - print numbers from 1 to LAST
 *   seq FIRST LAST     - print numbers from FIRST to LAST
 *   seq FIRST INCR LAST - print numbers from FIRST to LAST by INCR
 *
 * Options:
 *   -s STRING  use STRING to separate numbers (default: newline)
 *   -w         equalize width by padding with leading zeros
 */
export const seqCommand: Command = {
  name: "seq",

  async execute(args: string[]): Promise<ExecResult> {
    let separator = "\n";
    let equalizeWidth = false;
    const nums: string[] = [];

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg === "-s" && i + 1 < args.length) {
        separator = args[i + 1];
        i += 2;
        continue;
      }

      if (arg === "-w") {
        equalizeWidth = true;
        i++;
        continue;
      }

      if (arg === "--") {
        i++;
        break;
      }

      if (arg.startsWith("-") && arg !== "-") {
        // Check for combined flags or -sSTRING
        if (arg.startsWith("-s") && arg.length > 2) {
          separator = arg.slice(2);
          i++;
          continue;
        }
        if (arg === "-ws" || arg === "-sw") {
          equalizeWidth = true;
          if (i + 1 < args.length) {
            separator = args[i + 1];
            i += 2;
            continue;
          }
        }
        // Unknown option - treat as number (might be negative)
      }

      nums.push(arg);
      i++;
    }

    // Collect remaining args as numbers
    while (i < args.length) {
      nums.push(args[i]);
      i++;
    }

    if (nums.length === 0) {
      return {
        stdout: "",
        stderr: "seq: missing operand\n",
        exitCode: 1
      };
    }

    let first = 1;
    let increment = 1;
    let last: number;

    if (nums.length === 1) {
      last = parseFloat(nums[0]);
    } else if (nums.length === 2) {
      first = parseFloat(nums[0]);
      last = parseFloat(nums[1]);
    } else {
      first = parseFloat(nums[0]);
      increment = parseFloat(nums[1]);
      last = parseFloat(nums[2]);
    }

    // Validate numbers
    if (Number.isNaN(first) || Number.isNaN(increment) || Number.isNaN(last)) {
      const invalid = nums.find((n) => Number.isNaN(parseFloat(n)));
      return {
        stdout: "",
        stderr: `seq: invalid floating point argument: '${invalid}'\n`,
        exitCode: 1
      };
    }

    if (increment === 0) {
      return {
        stdout: "",
        stderr: "seq: invalid Zero increment value: '0'\n",
        exitCode: 1
      };
    }

    // Generate sequence
    const results: string[] = [];

    // Determine precision for floating point
    const getPrecision = (n: number): number => {
      const str = String(n);
      const dotIndex = str.indexOf(".");
      return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
    };

    const precision = Math.max(
      getPrecision(first),
      getPrecision(increment),
      getPrecision(last)
    );

    // Limit iterations to prevent infinite loops
    const maxIterations = 100000;
    let iterations = 0;

    if (increment > 0) {
      for (let n = first; n <= last + 1e-10; n += increment) {
        if (iterations++ > maxIterations) break;
        results.push(
          precision > 0 ? n.toFixed(precision) : String(Math.round(n))
        );
      }
    } else {
      for (let n = first; n >= last - 1e-10; n += increment) {
        if (iterations++ > maxIterations) break;
        results.push(
          precision > 0 ? n.toFixed(precision) : String(Math.round(n))
        );
      }
    }

    // Equalize width if requested
    if (equalizeWidth && results.length > 0) {
      const maxLen = Math.max(...results.map((r) => r.replace("-", "").length));
      for (let j = 0; j < results.length; j++) {
        const isNegative = results[j].startsWith("-");
        const num = isNegative ? results[j].slice(1) : results[j];
        const padded = num.padStart(maxLen, "0");
        results[j] = isNegative ? `-${padded}` : padded;
      }
    }

    const output = results.join(separator);
    return {
      stdout: output ? `${output}\n` : "",
      stderr: "",
      exitCode: 0
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "seq",
  flags: [
    { flag: "-s", type: "value", valueHint: "string" },
    { flag: "-w", type: "boolean" }
  ],
  needsArgs: true
};
