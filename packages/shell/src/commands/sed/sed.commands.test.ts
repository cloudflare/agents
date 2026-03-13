import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sed commands", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/test/file.txt": "line 1\nline 2\nline 3\nline 4\nline 5\n",
        "/test/alpha.txt": "alpha\nbeta\ngamma\ndelta\n"
      },
      cwd: "/test"
    });

  describe("Q command (quit without print)", () => {
    it("should quit without printing current line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '3Q' /test/file.txt");
      // Q quits without printing, so only lines 1-2 are output
      expect(result.stdout).toBe("line 1\nline 2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle Q at first line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '1Q' /test/file.txt");
      // Q at line 1 quits immediately, no output
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("q command (quit with print)", () => {
    it("should quit after printing current line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '3q' /test/file.txt");
      expect(result.stdout).toBe("line 1\nline 2\nline 3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle q at last line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '$q' /test/file.txt");
      // Prints all lines and quits at end
      expect(result.stdout).toBe("line 1\nline 2\nline 3\nline 4\nline 5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("l command (list with escapes)", () => {
    it("should show special characters with escapes", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\tb\nc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n 'l' /test.txt");
      // l command shows tabs as \t and ends lines with $
      expect(result.stdout).toContain("\\t");
      expect(result.stdout).toContain("$");
    });

    it("should show non-printable chars as octal", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\x01b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n 'l' /test.txt");
      // Control chars shown as octal like \001
      expect(result.stdout).toContain("\\001");
    });
  });

  describe("= command (print line number)", () => {
    it("should print line numbers", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '=' /test/file.txt");
      expect(result.stdout).toBe("1\n2\n3\n4\n5\n");
    });

    it("should print line number before pattern space", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '2{=;p}' /test/file.txt");
      expect(result.stdout).toBe("2\nline 2\n");
    });
  });

  describe("a/i/c commands (append/insert/change)", () => {
    it("should append text after line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '2a added' /test/alpha.txt");
      expect(result.stdout).toBe("alpha\nbeta\nadded\ngamma\ndelta\n");
    });

    it("should insert text before line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '2i inserted' /test/alpha.txt");
      expect(result.stdout).toBe("alpha\ninserted\nbeta\ngamma\ndelta\n");
    });

    it("should change/replace line", async () => {
      const env = createEnv();
      const result = await env.exec("sed '2c replaced' /test/alpha.txt");
      expect(result.stdout).toBe("alpha\nreplaced\ngamma\ndelta\n");
    });

    it("should change each line in range", async () => {
      const env = createEnv();
      const result = await env.exec("sed '2,3c replaced' /test/alpha.txt");
      // c replaces each matched line
      expect(result.stdout).toBe("alpha\nreplaced\nreplaced\ndelta\n");
    });
  });

  describe("n/N commands (next line)", () => {
    it("n should read next line into pattern space", async () => {
      const env = createEnv();
      // Print every other line starting from 2
      const result = await env.exec("sed -n 'n;p' /test/file.txt");
      expect(result.stdout).toBe("line 2\nline 4\n");
    });

    it("N should append next line to pattern space", async () => {
      const env = createEnv();
      // Join pairs of lines
      const result = await env.exec("sed 'N;s/\\n/ + /' /test/alpha.txt");
      expect(result.stdout).toBe("alpha + beta\ngamma + delta\n");
    });
  });

  describe("h/H/g/G/x commands (hold space)", () => {
    it("h should copy to hold space", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '1h;3{g;p}' /test/alpha.txt");
      // Line 3 pattern space contains line 1 from hold
      expect(result.stdout).toBe("alpha\n");
    });

    it("H should append to hold space", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '1h;2H;2{g;p}' /test/alpha.txt");
      // Hold space contains lines 1 and 2 separated by newline
      expect(result.stdout).toBe("alpha\nbeta\n");
    });

    it("G should append hold space to pattern", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '1h;3{G;p}' /test/alpha.txt");
      expect(result.stdout).toBe("gamma\nalpha\n");
    });

    it("x should exchange pattern and hold space", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '1h;2x;2p' /test/alpha.txt");
      // Line 2: exchange puts "alpha" in pattern, "beta" in hold
      expect(result.stdout).toBe("alpha\n");
    });
  });

  describe("D command (delete first line of pattern space)", () => {
    it("should delete up to first newline and restart", async () => {
      const env = createEnv();
      // N joins two lines, D deletes first and restarts
      const result = await env.exec("sed 'N;D' /test/file.txt");
      // Only last line remains (all prior lines get D'd)
      expect(result.stdout).toBe("line 5\n");
    });
  });

  describe("P command (print first line of pattern space)", () => {
    it("should print up to first newline", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n 'N;P' /test/alpha.txt");
      // P prints first line of joined pair
      expect(result.stdout).toBe("alpha\ngamma\n");
    });
  });

  describe("branching with b/t/T commands", () => {
    it("b should branch unconditionally", async () => {
      const env = createEnv();
      const result = await env.exec(
        "sed -e ':start;s/a/A/;t start;s/A/X/g' /test/alpha.txt"
      );
      // Loop replaces all a with A, then all A with X
      // The result has all a->A->X transformations
      expect(result.stdout).toBe("XlphX\nbetX\ngXmmX\ndeltX\n");
    });

    it("t should branch on successful substitution", async () => {
      const env = createEnv();
      // If substitution succeeds, skip to end
      const result = await env.exec(
        "sed -e 's/alpha/FOUND/;t end;s/./X/g;:end' /test/alpha.txt"
      );
      expect(result.stdout).toBe("FOUND\nXXXX\nXXXXX\nXXXXX\n");
    });

    it("T should branch when no substitution made", async () => {
      const env = createEnv();
      // T branches when no sub made - opposite of t
      const result = await env.exec(
        "sed -e 's/alpha/FOUND/;T skip;s/FOUND/REPLACED/;:skip' /test/alpha.txt"
      );
      expect(result.stdout).toBe("REPLACED\nbeta\ngamma\ndelta\n");
    });
  });

  describe("complex nested branching", () => {
    it("should handle nested braces", async () => {
      const env = createEnv();
      const result = await env.exec(
        "sed '2,3{s/e/E/g;s/a/A/g}' /test/alpha.txt"
      );
      expect(result.stdout).toBe("alpha\nbEtA\ngAmmA\ndelta\n");
    });

    it("should handle multiple -e scripts", async () => {
      const env = createEnv();
      const result = await env.exec(
        "sed -e 's/a/1/' -e 's/e/2/' -e 's/i/3/' /test/alpha.txt"
      );
      // Each -e substitution runs in sequence
      expect(result.stdout).toBe("1lpha\nb2t1\ng1mma\nd2lt1\n");
    });
  });

  describe("step addresses", () => {
    it("should match every nth line", async () => {
      const env = createEnv();
      // 1~2 matches lines 1, 3, 5, ...
      const result = await env.exec("sed -n '1~2p' /test/file.txt");
      expect(result.stdout).toBe("line 1\nline 3\nline 5\n");
    });

    it("should handle step starting from line 2", async () => {
      const env = createEnv();
      // 2~2 matches lines 2, 4, ...
      const result = await env.exec("sed -n '2~2p' /test/file.txt");
      expect(result.stdout).toBe("line 2\nline 4\n");
    });

    it("should handle step of 3", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '1~3p' /test/file.txt");
      expect(result.stdout).toBe("line 1\nline 4\n");
    });
  });

  describe("relative offset addresses", () => {
    it("should match relative offset after pattern", async () => {
      const env = createEnv();
      // /alpha/,+2 matches alpha and next 2 lines
      const result = await env.exec("sed -n '/alpha/,+2p' /test/alpha.txt");
      expect(result.stdout).toBe("alpha\nbeta\ngamma\n");
    });
  });

  describe("$ (last line) address", () => {
    it("should match last line", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '$p' /test/file.txt");
      expect(result.stdout).toBe("line 5\n");
    });

    it("should work in ranges", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '3,$p' /test/file.txt");
      expect(result.stdout).toBe("line 3\nline 4\nline 5\n");
    });
  });

  describe("negated addresses", () => {
    it("should negate single address", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '2!p' /test/alpha.txt");
      expect(result.stdout).toBe("alpha\ngamma\ndelta\n");
    });

    it("should negate address range", async () => {
      const env = createEnv();
      const result = await env.exec("sed -n '2,3!p' /test/alpha.txt");
      expect(result.stdout).toBe("alpha\ndelta\n");
    });
  });
});
