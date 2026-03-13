import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tr -c (complement)", () => {
  describe("complement with delete", () => {
    it("deletes characters NOT in set1", async () => {
      const env = new Bash();
      // Keep only digits by deleting complement of 0-9
      // Note: echo adds newline which is also deleted since it's not a digit
      const result = await env.exec("echo 'abc123def456' | tr -cd '0-9'");
      expect(result.stdout).toBe("123456");
    });

    it("keeps only alphanumeric characters", async () => {
      const env = new Bash();
      // Newline is deleted since it's not alphanumeric
      const result = await env.exec(
        "echo 'hello, world! 123' | tr -cd '[:alnum:]'"
      );
      expect(result.stdout).toBe("helloworld123");
    });

    it("keeps only letters", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'a1b2c3' | tr -cd '[:alpha:]'");
      expect(result.stdout).toBe("abc");
    });

    it("uses -C as equivalent to -c", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'abc123' | tr -Cd '0-9'");
      expect(result.stdout).toBe("123");
    });

    it("uses --complement long option", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'abc123' | tr --complement -d '0-9'");
      expect(result.stdout).toBe("123");
    });
  });

  describe("complement with translate", () => {
    it("translates characters NOT in set1", async () => {
      const env = new Bash();
      // Replace all non-digits with X (including newline)
      const result = await env.exec("echo 'abc123def' | tr -c '0-9' 'X'");
      expect(result.stdout).toBe("XXX123XXXX");
    });

    it("replaces non-alphanumeric with dash", async () => {
      const env = new Bash();
      // Space, !, and newline are not alphanumeric
      const result = await env.exec(
        "echo 'hello world!' | tr -c '[:alnum:]' '-'"
      );
      expect(result.stdout).toBe("hello-world--");
    });
  });

  describe("complement with squeeze", () => {
    it("squeezes characters NOT in set1", async () => {
      const env = new Bash();
      // Squeeze repeated non-digit characters (including the newline after replacement)
      const result = await env.exec("echo 'aaa111bbb222' | tr -cs '0-9' 'X'");
      expect(result.stdout).toBe("X111X222X");
    });
  });

  describe("combined with other options", () => {
    it("combines -c with -d", async () => {
      const env = new Bash();
      // Delete non-alpha characters (digits and newline)
      const result = await env.exec("echo 'test123test' | tr -cd '[:alpha:]'");
      expect(result.stdout).toBe("testtest");
    });
  });
});
