import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq dot-adjacency rules", () => {
  describe("adjacent keyword field access (should work)", () => {
    it.each([
      ["null", '"n"'],
      ["true", '"t"'],
      ["false", '"f"'],
      ["then", '"t"'],
      ["else", '"e"'],
      ["end", '"e"'],
      ["as", '"a"']
    ])(".%s should access field", async (kw, expected) => {
      const env = new Bash();
      const result = await env.exec(
        `echo '{"${kw}":"${expected.replace(/"/g, "")}"}' | jq '.${kw}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
    });
  });

  describe("chained adjacent keyword field access (should work)", () => {
    it.each(["null", "then", "as"])(
      ".data.%s should access nested field",
      async (kw) => {
        const env = new Bash();
        const result = await env.exec(
          `echo '{"data":{"${kw}":"val"}}' | jq '.data.${kw}'`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('"val"\n');
      }
    );
  });

  describe("space-separated keyword after dot (should error)", () => {
    it.each([
      "null",
      "true",
      "false",
      "not",
      "as",
      "then",
      "else",
      "end",
      "def",
      "reduce",
      "foreach",
      "label",
      "catch"
    ])(". %s should error", async (kw) => {
      const env = new Bash();
      const result = await env.exec(`echo '{"${kw}":"x"}' | jq '. ${kw}'`);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("chained space-separated keyword after dot (should error)", () => {
    it.each(["as", "or", "and", "then"])(
      ".data. %s should error",
      async (kw) => {
        const env = new Bash();
        const result = await env.exec(
          `echo '{"data":{"${kw}":"x"}}' | jq '.data. ${kw}'`
        );
        expect(result.exitCode).not.toBe(0);
      }
    );
  });

  describe("space-separated identifier after dot (should error)", () => {
    it("should error on '.  foo' (double space)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":\"x\"}' | jq '.  foo'");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("string after dot with whitespace (should work)", () => {
    it('should allow .  "foo" (double space + string)', async () => {
      const env = new Bash();
      const result = await env.exec('echo \'{"foo":"bar"}\' | jq \'.  "foo"\'');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('"bar"\n');
    });

    it('should allow ."foo" (adjacent string)', async () => {
      const env = new Bash();
      const result = await env.exec('echo \'{"foo":"bar"}\' | jq \'."foo"\'');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('"bar"\n');
    });

    it('should allow .data."foo" (chained adjacent string)', async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"data":{"foo":"bar"}}\' | jq \'.data."foo"\''
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('"bar"\n');
    });
  });

  describe("postfix dot after index/parens", () => {
    it("should error on .[0]. foo (space + ident after index)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[{\"foo\":1}]' | jq '.[0]. foo'");
      expect(result.exitCode).not.toBe(0);
    });

    it('should allow .[0]. "foo" (space + string after index)', async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '[{\"foo\":1}]' | jq '.[0]. \"foo\"'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n");
    });

    it("should error on (.). foo (space + ident after parens)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":1}' | jq '(.). foo'");
      expect(result.exitCode).not.toBe(0);
    });

    it('should allow (.). "foo" (space + string after parens)', async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":1}' | jq '(.). \"foo\"'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n");
    });
  });
});
