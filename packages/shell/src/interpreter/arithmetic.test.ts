import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("arithmetic evaluation", () => {
  describe("binary operators", () => {
    it("should evaluate addition", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((5 + 3))");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate subtraction", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((10 - 4))");
      expect(result.stdout).toBe("6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate multiplication", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((6 * 7))");
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate division", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((20 / 4))");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should truncate division result", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((7 / 2))");
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate modulo", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((17 % 5))");
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate exponentiation", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((2 ** 10))");
      expect(result.stdout).toBe("1024\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate left shift", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((1 << 8))");
      expect(result.stdout).toBe("256\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate right shift", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((256 >> 4))");
      expect(result.stdout).toBe("16\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate bitwise AND", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((12 & 10))");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate bitwise OR", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((12 | 10))");
      expect(result.stdout).toBe("14\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate bitwise XOR", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((12 ^ 10))");
      expect(result.stdout).toBe("6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate comma operator", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((1, 2, 3))");
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("comparison operators", () => {
    it("should evaluate less than", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((3 < 5)) $((5 < 3))");
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate less than or equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((3 <= 3)) $((4 <= 3))");
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate greater than", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((5 > 3)) $((3 > 5))");
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate greater than or equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((3 >= 3)) $((2 >= 3))");
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((5 == 5)) $((5 == 6))");
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate not equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((5 != 6)) $((5 != 5))");
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("logical operators", () => {
    it("should evaluate logical AND", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((1 && 1)) $((1 && 0)) $((0 && 1))");
      expect(result.stdout).toBe("1 0 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate logical OR", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((1 || 0)) $((0 || 1)) $((0 || 0))");
      expect(result.stdout).toBe("1 1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should short-circuit logical AND", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((0 && (x=10))); echo $x");
      expect(result.stdout).toBe("0\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should short-circuit logical OR", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((1 || (x=10))); echo $x");
      expect(result.stdout).toBe("1\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate logical NOT", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((!0)) $((!1)) $((!5))");
      expect(result.stdout).toBe("1 0 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("unary operators", () => {
    it("should evaluate unary minus", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((-5))");
      expect(result.stdout).toBe("-5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate unary plus", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((+5))");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate bitwise NOT", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((~0))");
      expect(result.stdout).toBe("-1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate pre-increment", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((++x)); echo $x");
      expect(result.stdout).toBe("6\n6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate post-increment", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((x++)); echo $x");
      expect(result.stdout).toBe("5\n6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate pre-decrement", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((--x)); echo $x");
      expect(result.stdout).toBe("4\n4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate post-decrement", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((x--)); echo $x");
      expect(result.stdout).toBe("5\n4\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary operator", () => {
    it("should evaluate true branch", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((1 ? 10 : 20))");
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate false branch", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((0 ? 10 : 20))");
      expect(result.stdout).toBe("20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate nested ternary", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((1 ? 2 ? 3 : 4 : 5))");
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("assignment operators", () => {
    it("should evaluate basic assignment", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((x = 5)); echo $x");
      expect(result.stdout).toBe("5\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate += assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=10; echo $((x += 5)); echo $x");
      expect(result.stdout).toBe("15\n15\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate -= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=10; echo $((x -= 3)); echo $x");
      expect(result.stdout).toBe("7\n7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate *= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=4; echo $((x *= 3)); echo $x");
      expect(result.stdout).toBe("12\n12\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate /= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=20; echo $((x /= 4)); echo $x");
      expect(result.stdout).toBe("5\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate %= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=17; echo $((x %= 5)); echo $x");
      expect(result.stdout).toBe("2\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate <<= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=2; echo $((x <<= 3)); echo $x");
      expect(result.stdout).toBe("16\n16\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate >>= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=32; echo $((x >>= 2)); echo $x");
      expect(result.stdout).toBe("8\n8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate &= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=12; echo $((x &= 10)); echo $x");
      expect(result.stdout).toBe("8\n8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate |= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=12; echo $((x |= 1)); echo $x");
      expect(result.stdout).toBe("13\n13\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate ^= assignment", async () => {
      const env = new Bash();
      const result = await env.exec("x=12; echo $((x ^= 5)); echo $x");
      expect(result.stdout).toBe("9\n9\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error cases", () => {
    it("should error on division by zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((5 / 0))");
      expect(result.stderr).toContain("division by 0");
      expect(result.exitCode).toBe(1);
    });

    it("should error on modulo by zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((5 % 0))");
      expect(result.stderr).toContain("division by 0");
      expect(result.exitCode).toBe(1);
    });

    it("should error on negative exponent", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((2 ** -1))");
      expect(result.stderr).toContain("exponent less than 0");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("variable references", () => {
    it("should reference variables without $", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $((x + 3))");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should reference variables with $", async () => {
      const env = new Bash();
      const result = await env.exec("x=5; echo $(($x + 3))");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle unset variables as zero", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((unset_var + 5))");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should recursively resolve variable names", async () => {
      const env = new Bash();
      const result = await env.exec("a=5; b=a; echo $((b))");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate expressions stored in variables", async () => {
      const env = new Bash();
      const result = await env.exec("e='1+2'; echo $((e + 3))");
      expect(result.stdout).toBe("6\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nested expressions", () => {
    it("should handle parentheses for grouping", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((2 * (3 + 4)))");
      expect(result.stdout).toBe("14\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle nested arithmetic expressions", async () => {
      const env = new Bash();
      const result = await env.exec("echo $(( (1 + 2) * 3 + 4 ))");
      expect(result.stdout).toBe("13\n");
      expect(result.exitCode).toBe(0);
    });

    it("should respect operator precedence", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((2 + 3 * 4))");
      expect(result.stdout).toBe("14\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array element arithmetic", () => {
    it("should handle array element access", async () => {
      const env = new Bash();
      const result = await env.exec("arr=(10 20 30); echo $((arr[1] + 5))");
      expect(result.stdout).toBe("25\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle array element assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        "arr=(0 0 0); echo $((arr[1] = 42)); echo ${arr[1]}"
      );
      expect(result.stdout).toBe("42\n42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle array element increment", async () => {
      const env = new Bash();
      const result = await env.exec(
        "arr=(10 20 30); echo $((arr[0]++)); echo ${arr[0]}"
      );
      expect(result.stdout).toBe("10\n11\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("number bases", () => {
    it("should handle octal numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((010))");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle hex numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((0xFF))");
      expect(result.stdout).toBe("255\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle base#number notation", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((2#1010))");
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle base 16 with letters", async () => {
      const env = new Bash();
      const result = await env.exec("echo $((16#ff))");
      expect(result.stdout).toBe("255\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("arithmetic command (( ))", () => {
    it("should return 0 for non-zero result", async () => {
      const env = new Bash();
      const result = await env.exec("(( 5 )); echo $?");
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 for zero result", async () => {
      const env = new Bash();
      const result = await env.exec("(( 0 )); echo $?");
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with assignments", async () => {
      const env = new Bash();
      const result = await env.exec("(( x = 5 + 3 )); echo $x");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
