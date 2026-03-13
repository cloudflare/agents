import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq filters", () => {
  describe("select and map", () => {
    it("should filter with select", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '[1,2,3,4,5]' | jq '[.[] | select(. > 3)]'"
      );
      expect(result.stdout).toBe("[\n  4,\n  5\n]\n");
    });

    it("should transform with map", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq 'map(. * 2)'");
      expect(result.stdout).toBe("[\n  2,\n  4,\n  6\n]\n");
    });

    it("should chain select and map", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '[1,2,3,4,5]' | jq '[.[] | select(. > 2) | . * 10]'"
      );
      expect(result.stdout).toBe("[\n  30,\n  40,\n  50\n]\n");
    });

    it("should select objects by field", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"n":1},{"n":5},{"n":2}]\' | jq -c \'[.[] | select(.n > 2)]\''
      );
      expect(result.stdout).toBe('[{"n":5}]\n');
    });
  });

  describe("has and in", () => {
    it("should check has for object", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":42}' | jq 'has(\"foo\")'");
      expect(result.stdout).toBe("true\n");
    });

    it("should check has for missing key", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":42}' | jq 'has(\"bar\")'");
      expect(result.stdout).toBe("false\n");
    });

    it("should check has for array", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq 'has(1)'");
      expect(result.stdout).toBe("true\n");
    });
  });

  describe("contains", () => {
    it("should check array contains", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq 'contains([2])'");
      expect(result.stdout).toBe("true\n");
    });

    it("should check object contains", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"a":1,"b":2}\' | jq \'contains({"a":1})\''
      );
      expect(result.stdout).toBe("true\n");
    });
  });

  describe("any and all", () => {
    it("should check any with expression", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3,4,5]' | jq 'any(. > 3)'");
      expect(result.stdout).toBe("true\n");
    });

    it("should check all with expression", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq 'all(. > 0)'");
      expect(result.stdout).toBe("true\n");
    });
  });

  describe("conditionals", () => {
    it("should evaluate if-then-else", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '5' | jq 'if . > 3 then \"big\" else \"small\" end'"
      );
      expect(result.stdout).toBe('"big"\n');
    });

    it("should evaluate else branch", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '2' | jq 'if . > 3 then \"big\" else \"small\" end'"
      );
      expect(result.stdout).toBe('"small"\n');
    });

    it("should evaluate elif", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'5\' | jq \'if . > 10 then "big" elif . > 3 then "medium" else "small" end\''
      );
      expect(result.stdout).toBe('"medium"\n');
    });
  });

  describe("optional operator", () => {
    it("should return null for missing key with ?", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'null' | jq '.foo?'");
      expect(result.stdout).toBe("null\n");
    });

    it("should return value if present with ?", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"foo\":42}' | jq '.foo?'");
      expect(result.stdout).toBe("42\n");
    });
  });

  describe("try-catch", () => {
    it("should catch errors", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1' | jq 'try error(\"oops\") catch \"caught\"'"
      );
      expect(result.stdout).toBe('"caught"\n');
    });
  });

  describe("variables", () => {
    it("should bind and use variable", async () => {
      const env = new Bash();
      const result = await env.exec("echo '5' | jq '. as $x | $x * $x'");
      expect(result.stdout).toBe("25\n");
    });

    it("should use variable in object construction", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '3' | jq -c '. as $n | {value: $n, doubled: ($n * 2)}'"
      );
      expect(result.stdout).toBe('{"value":3,"doubled":6}\n');
    });
  });
});
