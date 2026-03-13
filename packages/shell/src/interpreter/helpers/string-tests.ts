/**
 * String test helper for conditionals.
 * Handles -z (empty) and -n (non-empty) operators.
 */

export type StringTestOp = "-z" | "-n";

const STRING_TEST_OPS = new Set(["-z", "-n"]);

/**
 * Check if an operator is a string test operator.
 */
export function isStringTestOp(op: string): op is StringTestOp {
  return STRING_TEST_OPS.has(op);
}

/**
 * Evaluate a string test operator.
 */
export function evaluateStringTest(op: StringTestOp, value: string): boolean {
  switch (op) {
    case "-z":
      return value === "";
    case "-n":
      return value !== "";
  }
}
