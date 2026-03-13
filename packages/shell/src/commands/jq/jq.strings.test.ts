import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("jq string functions", () => {
  describe("split and join", () => {
    it("should split strings", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"a,b,c\"' | jq 'split(\",\")'");
      expect(result.stdout).toBe('[\n  "a",\n  "b",\n  "c"\n]\n');
    });

    it("should join arrays", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'["a","b","c"]\' | jq \'join("-")\''
      );
      expect(result.stdout).toBe('"a-b-c"\n');
    });
  });

  describe("test and match", () => {
    it("should test regex", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"foobar\"' | jq 'test(\"bar\")'");
      expect(result.stdout).toBe("true\n");
    });
  });

  describe("startswith and endswith", () => {
    it("should check startswith", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '\"hello world\"' | jq 'startswith(\"hello\")'"
      );
      expect(result.stdout).toBe("true\n");
    });

    it("should check endswith", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '\"hello world\"' | jq 'endswith(\"world\")'"
      );
      expect(result.stdout).toBe("true\n");
    });
  });

  describe("ltrimstr and rtrimstr", () => {
    it("should ltrimstr", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '\"hello world\"' | jq 'ltrimstr(\"hello \")'"
      );
      expect(result.stdout).toBe('"world"\n');
    });

    it("should rtrimstr", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '\"hello world\"' | jq 'rtrimstr(\" world\")'"
      );
      expect(result.stdout).toBe('"hello"\n');
    });
  });

  describe("case conversion", () => {
    it("should ascii_downcase", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"HELLO\"' | jq 'ascii_downcase'");
      expect(result.stdout).toBe('"hello"\n');
    });

    it("should ascii_upcase", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"hello\"' | jq 'ascii_upcase'");
      expect(result.stdout).toBe('"HELLO"\n');
    });
  });

  describe("sub and gsub", () => {
    it("should substitute first match", async () => {
      const env = new Bash();
      const result = await env.exec('echo \'"foobar"\' | jq \'sub("o"; "0")\'');
      expect(result.stdout).toBe('"f0obar"\n');
    });

    it("should substitute all matches", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo \'"foobar"\' | jq \'gsub("o"; "0")\''
      );
      expect(result.stdout).toBe('"f00bar"\n');
    });
  });

  describe("index and indices", () => {
    it("should find index in string", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"foobar\"' | jq 'index(\"bar\")'");
      expect(result.stdout).toBe("3\n");
    });

    it("should find all indices", async () => {
      const env = new Bash();
      const result = await env.exec("echo '\"abcabc\"' | jq 'indices(\"bc\")'");
      expect(result.stdout).toBe("[\n  1,\n  4\n]\n");
    });
  });
});
