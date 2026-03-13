import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("comm", () => {
  describe("basic comparison", () => {
    it("should show all three columns by default", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("a\n\t\tb\n\t\tc\n\td\n");
      expect(result.exitCode).toBe(0);
    });

    it("should suppress column 1 with -1", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm -1 /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("\tb\n\tc\nd\n");
      expect(result.exitCode).toBe(0);
    });

    it("should suppress column 2 with -2", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm -2 /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("a\n\tb\n\tc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should suppress column 3 with -3", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm -3 /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("a\n\td\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show only lines unique to file1 with -23", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm -23 /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("a\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show only lines unique to file2 with -13", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm -13 /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("d\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show only common lines with -12", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file1");
      await env.exec("echo -e 'b\\nc\\nd' > /tmp/file2");
      const result = await env.exec("comm -12 /tmp/file1 /tmp/file2");
      expect(result.stdout).toBe("b\nc\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle empty files", async () => {
      const env = new Bash();
      await env.exec("touch /tmp/empty1 /tmp/empty2");
      const result = await env.exec("comm /tmp/empty1 /tmp/empty2");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle identical files", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/same1");
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/same2");
      const result = await env.exec("comm /tmp/same1 /tmp/same2");
      expect(result.stdout).toBe("\t\ta\n\t\tb\n\t\tc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle completely different files", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb' > /tmp/diff1");
      await env.exec("echo -e 'c\\nd' > /tmp/diff2");
      const result = await env.exec("comm /tmp/diff1 /tmp/diff2");
      expect(result.stdout).toBe("a\nb\n\tc\n\td\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle stdin with -", async () => {
      const env = new Bash();
      await env.exec("echo -e 'a\\nb\\nc' > /tmp/file");
      const result = await env.exec("echo -e 'b\\nc\\nd' | comm /tmp/file -");
      expect(result.stdout).toBe("a\n\t\tb\n\t\tc\n\td\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error with missing operand", async () => {
      const env = new Bash();
      const result = await env.exec("comm");
      expect(result.stderr).toContain("missing operand");
      expect(result.exitCode).toBe(1);
    });

    it("should error with only one file", async () => {
      const env = new Bash();
      await env.exec("touch /tmp/only");
      const result = await env.exec("comm /tmp/only");
      expect(result.stderr).toContain("missing operand");
      expect(result.exitCode).toBe(1);
    });

    it("should error if file doesn't exist", async () => {
      const env = new Bash();
      await env.exec("touch /tmp/exists");
      const result = await env.exec("comm /tmp/exists /tmp/noexist");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--help", () => {
    it("should display help", async () => {
      const env = new Bash();
      const result = await env.exec("comm --help");
      expect(result.stdout).toContain("comm");
      expect(result.stdout).toContain("compare");
      expect(result.exitCode).toBe(0);
    });
  });
});
