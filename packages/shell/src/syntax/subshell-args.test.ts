import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Positional arguments and operator precedence", () => {
  describe("bash/sh positional arguments", () => {
    it("should handle bash -c with positional args (single quoted)", async () => {
      const env = new Bash();
      // Use single quotes so outer shell doesn't expand $1 $2
      const result = await env.exec("bash -c 'echo $1 $2' script arg1 arg2");
      expect(result.stdout).toBe("arg1 arg2\n");
    });

    it("should handle sh -c with positional args (single quoted)", async () => {
      const env = new Bash();
      const result = await env.exec("sh -c 'echo $1 $2' script arg1 arg2");
      expect(result.stdout).toBe("arg1 arg2\n");
    });

    it("should set $0 to script name", async () => {
      const env = new Bash();
      const result = await env.exec("bash -c 'echo $0' myscript");
      expect(result.stdout).toBe("myscript\n");
    });

    it("should handle script file with positional args", async () => {
      const env = new Bash({
        files: {
          "/script.sh": 'echo "Args: $1 $2 $3"'
        }
      });
      const result = await env.exec("bash /script.sh one two three");
      expect(result.stdout).toBe("Args: one two three\n");
    });

    it("should set $# to argument count", async () => {
      const env = new Bash();
      const result = await env.exec("bash -c 'echo $#' script a b c");
      expect(result.stdout).toBe("3\n");
    });

    it("should set $@ to all arguments", async () => {
      const env = new Bash();
      const result = await env.exec("bash -c 'echo $@' script a b c");
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("xargs positional arguments", () => {
    it("should append args to command", async () => {
      const env = new Bash();
      const result = await env.exec('echo "a b c" | xargs echo prefix');
      expect(result.stdout).toBe("prefix a b c\n");
    });

    it("should handle -I replacement", async () => {
      const env = new Bash();
      const result = await env.exec(
        'printf "one\\ntwo" | xargs -I {} echo item: {}'
      );
      expect(result.stdout).toBe("item: one\nitem: two\n");
    });

    it("should handle -n batching", async () => {
      const env = new Bash();
      const result = await env.exec('echo "a b c d" | xargs -n 2 echo');
      expect(result.stdout).toBe("a b\nc d\n");
    });

    it("should handle null-separated input with -0", async () => {
      const env = new Bash();
      // Simulate find -print0 style output
      const result = await env.exec(
        'printf "file1\\x00file2\\x00file3" | xargs -0 echo'
      );
      expect(result.stdout).toBe("file1 file2 file3\n");
    });
  });

  describe("Operator precedence", () => {
    it("! should bind tighter than &&", async () => {
      const env = new Bash();
      // ! false -> success (0), then && runs echo
      const result = await env.exec("! false && echo yes");
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("! should bind tighter than ||", async () => {
      const env = new Bash();
      // ! true -> failure (1), then || runs fallback
      const result = await env.exec("! true || echo fallback");
      expect(result.stdout).toBe("fallback\n");
      expect(result.exitCode).toBe(0);
    });

    it("! should negate entire pipeline", async () => {
      const env = new Bash();
      // In bash, ! negates the entire pipeline
      // ! echo hello | grep missing = ! (echo hello | grep missing)
      // grep fails (exit 1), negation makes it success (exit 0)
      const result = await env.exec("! echo hello | grep missing");
      expect(result.exitCode).toBe(0); // grep fails (1), negated to 0
    });

    it("! should negate successful pipeline", async () => {
      const env = new Bash();
      // ! echo hello | grep hello = ! (echo hello | grep hello)
      // grep succeeds (exit 0), negation makes it failure (exit 1)
      const result = await env.exec("! echo hello | grep hello");
      expect(result.exitCode).toBe(1); // grep succeeds (0), negated to 1
    });

    it("&& and || should be left-associative", async () => {
      const env = new Bash();
      // true || echo no && echo yes
      // Should be: (true || echo no) && echo yes
      // true succeeds, || short-circuits, then && echo yes runs
      const result = await env.exec("true || echo no && echo yes");
      expect(result.stdout).toBe("yes\n");
    });

    it("; should have lowest precedence", async () => {
      const env = new Bash();
      // false && echo no ; echo always
      // Should be: (false && echo no) ; echo always
      const result = await env.exec("false && echo no ; echo always");
      expect(result.stdout).toBe("always\n");
    });

    it("double negation should cancel out", async () => {
      const env = new Bash();
      // ! ! true = negate(negate(true)) = negate(1) = 0
      const result = await env.exec("! ! true");
      expect(result.exitCode).toBe(0);
    });

    it("double negation of false should give 1", async () => {
      const env = new Bash();
      // ! ! false = negate(negate(false)) = negate(0) = 1
      const result = await env.exec("! ! false");
      expect(result.exitCode).toBe(1);
    });

    it("triple negation should negate once", async () => {
      const env = new Bash();
      // ! ! ! true = negate(negate(negate(true))) = negate(0) = 1
      const result = await env.exec("! ! ! true");
      expect(result.exitCode).toBe(1);
    });

    it("triple negation of false should give 0", async () => {
      const env = new Bash();
      // ! ! ! false = negate(negate(negate(false))) = negate(1) = 0
      const result = await env.exec("! ! ! false");
      expect(result.exitCode).toBe(0);
    });

    it("quadruple negation should cancel out", async () => {
      const env = new Bash();
      // ! ! ! ! true = even count, no change
      const result = await env.exec("! ! ! ! true");
      expect(result.exitCode).toBe(0);
    });
  });
});
