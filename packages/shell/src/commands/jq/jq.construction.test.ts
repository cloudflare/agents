import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq construction", () => {
  describe("object construction", () => {
    it("should construct object with static keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"name":"test","value":42}\' | jq -c \'{n: .name, v: .value}\''
      );
      expect(result.stdout).toBe('{"n":"test","v":42}\n');
    });

    it("should construct object with shorthand", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"name":"test","value":42}\' | jq -c \'{name, value}\''
      );
      expect(result.stdout).toBe('{"name":"test","value":42}\n');
    });

    it("should construct object with dynamic keys", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"key":"foo","val":42}\' | jq -c \'{(.key): .val}\''
      );
      expect(result.stdout).toBe('{"foo":42}\n');
    });

    it("should allow pipes in object values", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '[[1,2],[3,4]]' | jq -c '{a: .[0] | add, b: .[1] | add}'"
      );
      expect(result.stdout).toBe('{"a":3,"b":7}\n');
    });
  });

  describe("array construction", () => {
    it("should construct array from iterator", async () => {
      const env = new Bash();
      const result = await env.exec("echo '{\"a\":1,\"b\":2}' | jq '[.a, .b]'");
      expect(result.stdout).toBe("[\n  1,\n  2\n]\n");
    });

    it("should construct array from object values", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'{"a":1,"b":2,"c":3}\' | jq \'[.[]]\''
      );
      expect(result.stdout).toBe("[\n  1,\n  2,\n  3\n]\n");
    });
  });
});
