import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("local builtin", () => {
  describe("basic local variables", () => {
    it("should declare local variable with value", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local x=hello; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("hello\n");
    });

    it("should not affect outer scope", async () => {
      const env = new Bash({ env: { x: "outer" } });
      const result = await env.exec(
        "test_func() { local x=inner; echo $x; }; test_func; echo $x"
      );
      expect(result.stdout).toBe("inner\nouter\n");
    });

    it("should shadow outer variable", async () => {
      const env = new Bash({ env: { x: "outer" } });
      const result = await env.exec(
        "test_func() { local x=inner; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("inner\n");
    });

    it("should restore undefined variable after function", async () => {
      const env = new Bash();
      const result = await env.exec(
        'test_func() { local newvar=value; echo $newvar; }; test_func; echo "[$newvar]"'
      );
      expect(result.stdout).toBe("value\n[]\n");
    });

    it("should declare local without value", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local x; x=assigned; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("assigned\n");
    });
  });

  describe("multiple local declarations", () => {
    it("should handle multiple local declarations", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local a=1 b=2 c=3; echo $a $b $c; }; test_func"
      );
      expect(result.stdout).toBe("1 2 3\n");
    });

    it("should handle mixed declarations with and without values", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local a=1 b c=3; b=2; echo $a $b $c; }; test_func"
      );
      expect(result.stdout).toBe("1 2 3\n");
    });
  });

  describe("nested functions", () => {
    it("should work with nested function calls", async () => {
      const env = new Bash();
      const result = await env.exec(
        "inner() { local x=inner; echo $x; }; outer() { local x=outer; inner; echo $x; }; outer"
      );
      expect(result.stdout).toBe("inner\nouter\n");
    });

    it("should keep local changes within same scope", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local x=first; x=second; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("second\n");
    });

    it("should not leak local from inner to outer function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        inner() { local y=inner; }
        outer() {
          local x=outer
          inner
          echo "x=$x y=$y"
        }
        outer
      `);
      expect(result.stdout).toBe("x=outer y=\n");
    });
  });

  describe("error cases", () => {
    it("should error when used outside function", async () => {
      const env = new Bash();
      const result = await env.exec("local x=value");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("can only be used in a function");
    });

    it("should error when used in subshell outside function", async () => {
      const env = new Bash();
      const result = await env.exec("(local x=value)");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("local with special values", () => {
    it("should handle local with empty value", async () => {
      const env = new Bash();
      const result = await env.exec(
        'test_func() { local x=; echo "x is $x end"; }; test_func'
      );
      expect(result.stdout).toBe("x is  end\n");
    });

    it("should handle local with spaces in value (quoted)", async () => {
      const env = new Bash();
      const result = await env.exec(
        'test_func() { local x="hello world"; echo "$x"; }; test_func'
      );
      expect(result.stdout).toBe("hello world\n");
    });

    it("should handle local with variable expansion", async () => {
      const env = new Bash({ env: { OUTER: "expanded" } });
      const result = await env.exec(
        'test_func() { local x=$OUTER; echo "$x"; }; test_func'
      );
      expect(result.stdout).toBe("expanded\n");
    });
  });

  describe("local scope restoration", () => {
    it("should restore original value after function returns", async () => {
      const env = new Bash();
      const result = await env.exec(`
        x=global
        test_func() {
          local x=local
          echo "inside: $x"
        }
        echo "before: $x"
        test_func
        echo "after: $x"
      `);
      expect(result.stdout).toBe(
        "before: global\ninside: local\nafter: global\n"
      );
    });

    it("should handle recursive functions with local", async () => {
      const env = new Bash();
      const result = await env.exec(`
        countdown() {
          local n=$1
          if [ $n -le 0 ]; then
            echo "done"
            return
          fi
          echo $n
          countdown $((n - 1))
        }
        countdown 3
      `);
      expect(result.stdout).toBe("3\n2\n1\ndone\n");
    });
  });
});
