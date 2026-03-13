import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq keyword field access", () => {
  describe("field names that are keywords should be accessible with dot notation", () => {
    it("should access .label field", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"label\":\"hello\"}' | jq '.label'"
      );
      expect(result.stdout).toBe('"hello"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access .and field", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"and\":true}' | jq '.and'");
      expect(result.stdout).toBe("true\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access .or field", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"or\":false}' | jq '.or'");
      expect(result.stdout).toBe("false\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access .not field", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"not\":42}' | jq '.not'");
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access .if field", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"if\":\"value\"}' | jq '.if'");
      expect(result.stdout).toBe('"value"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access .try field", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"try\":1}' | jq '.try'");
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access .catch field", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"catch\":2}' | jq '.catch'");
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access .reduce field", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"reduce\":\"data\"}' | jq '.reduce'"
      );
      expect(result.stdout).toBe('"data"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access .foreach field", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"foreach\":\"items\"}' | jq '.foreach'"
      );
      expect(result.stdout).toBe('"items"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access .def field", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"def\":\"definition\"}' | jq '.def'"
      );
      expect(result.stdout).toBe('"definition"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access .break field", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"break\":\"stop\"}' | jq '.break'"
      );
      expect(result.stdout).toBe('"stop"\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("chained keyword field access", () => {
    it("should access nested .label field", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"data":{"label":"nested"}}\' | jq \'.data.label\''
      );
      expect(result.stdout).toBe('"nested"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access .label in compact output", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"label":"x","value":1}\' | jq -c \'{lab: .label, val: .value}\''
      );
      expect(result.stdout).toBe('{"lab":"x","val":1}\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("space-separated keyword after dot should NOT be field access", () => {
    it("should error on '. if' (space before keyword)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"if\":\"value\"}' | jq '. if'");
      expect(result.exitCode).not.toBe(0);
    });

    it("should error on '. and' (space before keyword)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"and\":true}' | jq '. and'");
      expect(result.exitCode).not.toBe(0);
    });

    it("should error on '. try' (space before keyword)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"try\":1}' | jq '. try'");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("space-separated identifier after dot should NOT be field access", () => {
    it("should error on '. foo' (space before identifier)", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":\"bar\"}' | jq '. foo'");
      expect(result.exitCode).not.toBe(0);
    });

    it("should error on '.data. foo' (chained, space before identifier)", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"data":{"foo":"bar"}}\' | jq \'.data. foo\''
      );
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("space-separated string after dot SHOULD be field access", () => {
    it("should allow '. \"foo\"' (space before string)", async () => {
      const env = new Bash();
      const result = await env.exec('echo \'{"foo":"bar"}\' | jq \'. "foo"\'');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('"bar"\n');
    });

    it("should allow '.data. \"foo\"' (chained, space before string)", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"data":{"foo":"bar"}}\' | jq \'.data. "foo"\''
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('"bar"\n');
    });
  });

  describe("keyword as object key", () => {
    it("should allow keyword as object construction key with value", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"label\":\"hello\"}' | jq -c '{label: .label}'"
      );
      expect(result.stdout).toBe('{"label":"hello"}\n');
      expect(result.exitCode).toBe(0);
    });

    it("should allow keyword as object shorthand key", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"label\":\"hello\"}' | jq -c '{label}'"
      );
      expect(result.stdout).toBe('{"label":"hello"}\n');
      expect(result.exitCode).toBe(0);
    });

    it("should allow 'not' as object key", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"not\":true}' | jq -c '{not: .not}'"
      );
      expect(result.stdout).toBe('{"not":true}\n');
      expect(result.exitCode).toBe(0);
    });

    it("should allow 'and' as object shorthand key", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"and\":1}' | jq -c '{and}'");
      expect(result.stdout).toBe('{"and":1}\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("keyword as object destructuring pattern key", () => {
    it("should allow keyword key in object destructuring", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"label\":\"hello\"}' | jq -c '. as {label: $l} | $l'"
      );
      expect(result.stdout).toBe('"hello"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should allow keyword shorthand in object destructuring", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"not\":42}' | jq '. as {$not} | $not'"
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
