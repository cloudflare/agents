import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk output control", () => {
  describe("OFS (output field separator)", () => {
    it("should use default OFS (space)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk '{ print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a b c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use custom OFS", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN { OFS = ":" } { print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a:b:c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use OFS with tab", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN { OFS = "\\t" } { print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a\tb\tc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use multi-character OFS", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk 'BEGIN { OFS = " | " } { print $1, $2, $3 }'`
      );
      expect(result.stdout).toBe("a | b | c\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ORS (output record separator)", () => {
    it("should use default ORS (newline)", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(`awk '{ print $0 }' /data.txt`);
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use custom ORS", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(
        `awk 'BEGIN { ORS = ";" } { print $0 }' /data.txt`
      );
      expect(result.stdout).toBe("a;b;c;");
      expect(result.exitCode).toBe(0);
    });

    it("should use empty ORS", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(
        `awk 'BEGIN { ORS = "" } { print $0 }' /data.txt`
      );
      expect(result.stdout).toBe("abc");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("print without arguments", () => {
    it("should print $0 when no arguments", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "hello world" | awk '{ print }'`);
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("printf without newline", () => {
    it("should not add newline after printf", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "no newline" }'`
      );
      expect(result.stdout).toBe("no newline");
      expect(result.exitCode).toBe(0);
    });

    it("should allow explicit newline in printf", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "with newline\\n" }'`
      );
      expect(result.stdout).toBe("with newline\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("printf with special features", () => {
    it("should handle parenthesized printf", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "42" | awk '{ printf("%d\\n", $1) }'`
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle printf length modifiers", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "10" | awk '{ printf("%d %ld %lld\\n", $1, $1, $1) }'`
      );
      expect(result.stdout).toBe("10 10 10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle %*s width specifier", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf("a%*sb\\n", 5, "x") }'`
      );
      expect(result.stdout).toBe("a    xb\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle negative %*s width specifier", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf("a%*sb\\n", -5, "x") }'`
      );
      expect(result.stdout).toBe("ax    b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("file output redirection", () => {
    it("should redirect to file with >", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '{ print "output" > "/tmp/out.txt" }' && cat /tmp/out.txt`
      );
      expect(result.stdout).toBe("output\n");
      expect(result.exitCode).toBe(0);
    });

    it("should append to file with >>", async () => {
      const env = new Bash({
        files: { "/tmp/existing.txt": "line1\n" }
      });
      const result = await env.exec(
        `echo "test" | awk '{ print "line2" >> "/tmp/existing.txt" }' && cat /tmp/existing.txt`
      );
      expect(result.stdout).toBe("line1\nline2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should write multiple lines to same file with >", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(
        `awk '{ print $0 > "/tmp/out.txt" }' /data.txt && cat /tmp/out.txt`
      );
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
