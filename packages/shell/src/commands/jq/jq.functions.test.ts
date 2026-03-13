import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq builtin functions", () => {
  describe("keys and values", () => {
    it("should get keys sorted", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"b\":1,\"a\":2}' | jq 'keys'");
      expect(result.stdout).toBe('[\n  "a",\n  "b"\n]\n');
      expect(result.exitCode).toBe(0);
    });

    it("should get values with .[]]", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1,\"b\":2}' | jq '[.[]]'");
      expect(result.stdout).toBe("[\n  1,\n  2\n]\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("length", () => {
    it("should get length of array", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3,4,5]' | jq 'length'");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should get length of string", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"hello\"' | jq 'length'");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should get length of object", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1,\"b\":2}' | jq 'length'");
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("type", () => {
    it("should get type of object", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1}' | jq 'type'");
      expect(result.stdout).toBe('"object"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should get type of array", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2]' | jq 'type'");
      expect(result.stdout).toBe('"array"\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("first and last", () => {
    it("should get first element", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[5,10,15]' | jq 'first'");
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should get last element", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[5,10,15]' | jq 'last'");
      expect(result.stdout).toBe("15\n");
      expect(result.exitCode).toBe(0);
    });

    it("should get first of expression", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'first(range(10))'");
      expect(result.stdout).toBe("0\n");
    });
  });

  describe("reverse", () => {
    it("should reverse array", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3]' | jq 'reverse'");
      expect(result.stdout).toBe("[\n  3,\n  2,\n  1\n]\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sort and unique", () => {
    it("should sort array", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[3,1,2]' | jq 'sort'");
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3\n]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should get unique values", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,1,3,2]' | jq 'unique'");
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3\n]\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("add", () => {
    it("should add numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[1,2,3,4]' | jq 'add'");
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should concatenate strings", async () => {
      const env = new Bash();
      const result = await env.exec('echo \'["a","b","c"]\' | jq \'add\'');
      expect(result.stdout).toBe('"abc"\n');
      expect(result.exitCode).toBe(0);
    });
  });

  describe("min and max", () => {
    it("should get min value", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[5,2,8,1]' | jq 'min'");
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should get max value", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[5,2,8,1]' | jq 'max'");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should find min_by", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"n":3},{"n":1},{"n":2}]\' | jq -c \'min_by(.n)\''
      );
      expect(result.stdout).toBe('{"n":1}\n');
    });

    it("should find max_by", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"n":3},{"n":1},{"n":2}]\' | jq -c \'max_by(.n)\''
      );
      expect(result.stdout).toBe('{"n":3}\n');
    });
  });

  describe("flatten", () => {
    it("should flatten arrays", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[[1,2],[3,4]]' | jq 'flatten'");
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3,\n  4\n]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should flatten with specific depth", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[[[1]],[[2]]]' | jq 'flatten(1)'");
      expect(result.stdout).toBe("[\n  [\n    1\n  ],\n  [\n    2\n  ]\n]\n");
    });
  });

  describe("group_by and sort_by", () => {
    it("should sort_by field", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"n":3},{"n":1},{"n":2}]\' | jq -c \'sort_by(.n)\''
      );
      expect(result.stdout).toBe('[{"n":1},{"n":2},{"n":3}]\n');
    });

    it("should group_by field", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"g":1,"v":"a"},{"g":2,"v":"b"},{"g":1,"v":"c"}]\' | jq -c \'group_by(.g)\''
      );
      expect(result.stdout).toBe(
        '[[{"g":1,"v":"a"},{"g":1,"v":"c"}],[{"g":2,"v":"b"}]]\n'
      );
    });

    it("should unique_by field", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"n":1},{"n":2},{"n":1}]\' | jq -c \'unique_by(.n)\''
      );
      expect(result.stdout).toBe('[{"n":1},{"n":2}]\n');
    });
  });

  describe("to_entries and from_entries", () => {
    it("should convert to entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"a\":1,\"b\":2}' | jq -c 'to_entries'"
      );
      expect(result.stdout).toBe(
        '[{"key":"a","value":1},{"key":"b","value":2}]\n'
      );
    });

    it("should convert from entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'[{"key":"a","value":1}]\' | jq -c \'from_entries\''
      );
      expect(result.stdout).toBe('{"a":1}\n');
    });

    it("should use with_entries", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"a\":1,\"b\":2}' | jq -c 'with_entries({key: .key, value: (.value + 10)})'"
      );
      expect(result.stdout).toBe('{"a":11,"b":12}\n');
    });
  });

  describe("transpose", () => {
    it("should transpose matrix", async () => {
      const env = new Bash();
      const result = await env.exec("echo '[[1,2],[3,4]]' | jq 'transpose'");
      expect(result.stdout).toBe(
        "[\n  [\n    1,\n    3\n  ],\n  [\n    2,\n    4\n  ]\n]\n"
      );
    });
  });

  describe("range", () => {
    it("should generate range", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n '[range(5)]'");
      expect(result.stdout).toBe("[\n  0,\n  1,\n  2,\n  3,\n  4\n]\n");
    });

    it("should generate range with start and end", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n '[range(2;5)]'");
      expect(result.stdout).toBe("[\n  2,\n  3,\n  4\n]\n");
    });
  });

  describe("limit", () => {
    it("should limit results", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n '[limit(3; range(10))]'");
      expect(result.stdout).toBe("[\n  0,\n  1,\n  2\n]\n");
    });
  });

  describe("getpath and setpath", () => {
    it("should getpath", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"a":{"b":42}}\' | jq \'getpath(["a","b"])\''
      );
      expect(result.stdout).toBe("42\n");
    });

    it("should setpath", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"a\":1}' | jq -c 'setpath([\"b\"]; 2)'"
      );
      expect(result.stdout).toBe('{"a":1,"b":2}\n');
    });
  });

  describe("recurse", () => {
    it("should recurse through structure", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '{\"a\":{\"b\":1}}' | jq '[.. | numbers]'"
      );
      expect(result.stdout).toBe("[\n  1\n]\n");
    });
  });

  describe("math functions with two arguments", () => {
    it("should compute pow(base; exp)", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'pow(2; 3)'");
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute pow with non-integer exponent", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'pow(4; 0.5)'");
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute atan2(y; x)", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'atan2(3; 4)'");
      expect(result.stdout).toBe("0.6435011087932844\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute atan2 with negative values", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'atan2(-1; -1)'");
      // atan2(-1, -1) = -2.356194490192345 (third quadrant)
      expect(result.stdout).toBe("-2.356194490192345\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return null for pow with non-numeric args", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'pow(\"a\"; 2)'");
      expect(result.stdout).toBe("null\n");
    });

    it("should return null for atan2 with non-numeric args", async () => {
      const env = new Bash();
      const result = await env.exec("jq -n 'atan2(\"a\"; 2)'");
      expect(result.stdout).toBe("null\n");
    });
  });
});
