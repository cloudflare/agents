/**
 * Shared Operators
 *
 * Common operator implementations shared between bash arithmetic and AWK.
 */

/**
 * Apply a binary arithmetic operator.
 * Shared between bash arithmetic and AWK.
 */
export function applyNumericBinaryOp(
  left: number,
  right: number,
  operator: string
): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right !== 0 ? left / right : 0;
    case "%":
      return right !== 0 ? left % right : 0;
    case "^":
    case "**":
      return left ** right;
    default:
      return 0;
  }
}
