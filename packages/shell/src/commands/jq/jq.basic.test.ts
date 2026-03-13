import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq basic", () => {
  describe("identity filter", () => {
    it("should pass through JSON with .", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1}' | jq '.'");
      expect(result.stdout).toBe('{\n  "a": 1\n}\n');
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should pretty print arrays", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq '.'");
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3\n]\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("object access", () => {
    it("should access object key with .key", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"name\":\"test\"}' | jq '.name'");
      expect(result.stdout).toBe('"test"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access nested key with .a.b", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"a":{"b":"nested"}}\' | jq \'.a.b\''
      );
      expect(result.stdout).toBe('"nested"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should return null for missing key", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1}' | jq '.missing'");
      expect(result.stdout).toBe("null\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access numeric values", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"count\":42}' | jq '.count'");
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access boolean values", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"active\":true}' | jq '.active'");
      expect(result.stdout).toBe("true\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array access", () => {
    it("should access array element with .[0]", async () => {
      const env = new Bash();
      const result = await env.exec('echo \'["a","b","c"]\' | jq \'.[0]\'');
      expect(result.stdout).toBe('"a"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should access last element with .[-1]", async () => {
      const env = new Bash();
      const result = await env.exec('echo \'["a","b","c"]\' | jq \'.[-1]\'');
      expect(result.stdout).toBe('"c"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should return null for out of bounds index", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2]' | jq '.[99]'");
      expect(result.stdout).toBe("null\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array iteration", () => {
    it("should iterate array with .[]", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq '.[]'");
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate object values with .[]", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1,\"b\":2}' | jq '.[]'");
      expect(result.stdout).toBe("1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate nested array with .items[]", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"items\":[1,2,3]}' | jq '.items[]'"
      );
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("pipes", () => {
    it("should pipe filters with |", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"data\":{\"value\":42}}' | jq '.data | .value'"
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should chain multiple pipes", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"a":{"b":{"c":"deep"}}}\' | jq \'.a | .b | .c\''
      );
      expect(result.stdout).toBe('"deep"\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array slicing", () => {
    it("should slice with start and end", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[0,1,2,3,4,5]' | jq '.[2:4]'");
      expect(result.stdout).toBe("[\n  2,\n  3\n]\n");
    });

    it("should slice from start", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[0,1,2,3,4]' | jq '.[:3]'");
      expect(result.stdout).toBe("[\n  0,\n  1,\n  2\n]\n");
    });

    it("should slice to end", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[0,1,2,3,4]' | jq '.[3:]'");
      expect(result.stdout).toBe("[\n  3,\n  4\n]\n");
    });

    it("should slice strings", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"hello\"' | jq '.[1:4]'");
      expect(result.stdout).toBe('"ell"\n');
    });

    it("should access with negative index in slice", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[0,1,2,3,4]' | jq '.[-2:]'");
      expect(result.stdout).toBe("[\n  3,\n  4\n]\n");
    });
  });

  describe("comma operator", () => {
    it("should output multiple values", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1,\"b\":2}' | jq '.a, .b'");
      expect(result.stdout).toBe("1\n2\n");
    });

    it("should work with three values", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"x":1,"y":2,"z":3}\' | jq \'.x, .y, .z\''
      );
      expect(result.stdout).toBe("1\n2\n3\n");
    });
  });
});
