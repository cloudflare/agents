import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq operators", () => {
  describe("arithmetic operators", () => {
    it("should add numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '5' | jq '. + 3'");
      expect(result.stdout).toBe("8\n");
    });

    it("should subtract numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '10' | jq '. - 4'");
      expect(result.stdout).toBe("6\n");
    });

    it("should multiply numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '6' | jq '. * 7'");
      expect(result.stdout).toBe("42\n");
    });

    it("should divide numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '20' | jq '. / 4'");
      expect(result.stdout).toBe("5\n");
    });

    it("should modulo numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '17' | jq '. % 5'");
      expect(result.stdout).toBe("2\n");
    });

    it("should concatenate strings with +", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"a":"foo","b":"bar"}\' | jq \'.a + .b\''
      );
      expect(result.stdout).toBe('"foobar"\n');
    });

    it("should concatenate arrays with +", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[[1,2],[3,4]]' | jq '.[0] + .[1]'");
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3,\n  4\n]\n");
    });

    it("should merge objects with +", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '[{\"a\":1},{\"b\":2}]' | jq -c '.[0] + .[1]'"
      );
      expect(result.stdout).toBe('{"a":1,"b":2}\n');
    });
  });

  describe("comparison operators", () => {
    it("should compare equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo '5' | jq '. == 5'");
      expect(result.stdout).toBe("true\n");
    });

    it("should compare not equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo '5' | jq '. != 3'");
      expect(result.stdout).toBe("true\n");
    });

    it("should compare less than", async () => {
      const env = new Bash();
      const result = await env.exec("echo '3' | jq '. < 5'");
      expect(result.stdout).toBe("true\n");
    });

    it("should compare greater than", async () => {
      const env = new Bash();
      const result = await env.exec("echo '10' | jq '. > 5'");
      expect(result.stdout).toBe("true\n");
    });

    it("should compare less than or equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo '5' | jq '. <= 5'");
      expect(result.stdout).toBe("true\n");
    });

    it("should compare greater than or equal", async () => {
      const env = new Bash();
      const result = await env.exec("echo '5' | jq '. >= 5'");
      expect(result.stdout).toBe("true\n");
    });
  });

  describe("logical operators", () => {
    it("should evaluate and", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'true' | jq '. and true'");
      expect(result.stdout).toBe("true\n");
    });

    it("should evaluate or", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'false' | jq '. or true'");
      expect(result.stdout).toBe("true\n");
    });

    it("should evaluate not", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'true' | jq 'not'");
      expect(result.stdout).toBe("false\n");
    });

    it("should use alternative operator //", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"a\":null}' | jq '.a // \"default\"'"
      );
      expect(result.stdout).toBe('"default"\n');
    });

    it("should return value if not null with //", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"a\":42}' | jq '.a // \"default\"'"
      );
      expect(result.stdout).toBe("42\n");
    });
  });

  describe("math functions", () => {
    it("should floor", async () => {
      const env = new Bash();
      const result = await env.exec("echo '3.7' | jq 'floor'");
      expect(result.stdout).toBe("3\n");
    });

    it("should ceil", async () => {
      const env = new Bash();
      const result = await env.exec("echo '3.2' | jq 'ceil'");
      expect(result.stdout).toBe("4\n");
    });

    it("should round", async () => {
      const env = new Bash();
      const result = await env.exec("echo '3.5' | jq 'round'");
      expect(result.stdout).toBe("4\n");
    });

    it("should sqrt", async () => {
      const env = new Bash();
      const result = await env.exec("echo '16' | jq 'sqrt'");
      expect(result.stdout).toBe("4\n");
    });

    it("should abs", async () => {
      const env = new Bash();
      const result = await env.exec("echo '-5' | jq 'abs'");
      expect(result.stdout).toBe("5\n");
    });
  });

  describe("type conversion", () => {
    it("should tostring", async () => {
      const env = new Bash();
      const result = await env.exec("echo '42' | jq 'tostring'");
      expect(result.stdout).toBe('"42"\n');
    });

    it("should tonumber", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"42\"' | jq 'tonumber'");
      expect(result.stdout).toBe("42\n");
    });
  });
});
