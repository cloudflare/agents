import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("help builtin", () => {
  describe("list all builtins", () => {
    it("should list shell builtins", async () => {
      const env = new Bash();
      const result = await env.exec("help");
      expect(result.stdout).toContain("@cloudflare/shell builtins");
      expect(result.exitCode).toBe(0);
    });

    it("should show common builtins", async () => {
      const env = new Bash();
      const result = await env.exec("help");
      expect(result.stdout).toContain("cd");
      expect(result.stdout).toContain("export");
      expect(result.stdout).toContain("echo");
    });
  });

  describe("help for specific builtin", () => {
    it("should show help for cd", async () => {
      const env = new Bash();
      const result = await env.exec("help cd");
      expect(result.stdout).toContain("cd");
      expect(result.stdout).toContain("Change");
      expect(result.exitCode).toBe(0);
    });

    it("should show help for export", async () => {
      const env = new Bash();
      const result = await env.exec("help export");
      expect(result.stdout).toContain("export");
      expect(result.exitCode).toBe(0);
    });

    it("should error for unknown builtin", async () => {
      const env = new Bash();
      const result = await env.exec("help nonexistent");
      expect(result.stderr).toContain("no help topics match");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("-s flag (short form)", () => {
    it("should show short synopsis for cd", async () => {
      const env = new Bash();
      const result = await env.exec("help -s cd");
      expect(result.stdout).toContain("cd:");
      expect(result.stdout).toContain("cd [-L|-P]");
      expect(result.exitCode).toBe(0);
    });

    it("should show short synopsis for help", async () => {
      const env = new Bash();
      const result = await env.exec("help -s help");
      expect(result.stdout).toContain("help:");
      expect(result.stdout).toContain("help [-s]");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-- option terminator", () => {
    it("should handle -- before pattern", async () => {
      const env = new Bash();
      const result = await env.exec("help -- help");
      expect(result.stdout).toContain("help");
      expect(result.stdout).toContain("Display");
      expect(result.exitCode).toBe(0);
    });
  });
});
