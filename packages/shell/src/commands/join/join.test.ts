import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("join", () => {
  describe("basic functionality", () => {
    it("joins two files on first field", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n2 banana\n3 cherry\n",
          "/b.txt": "1 red\n2 yellow\n3 red\n"
        }
      });
      const result = await bash.exec("join /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "1 apple red\n2 banana yellow\n3 cherry red\n"
      );
    });

    it("only outputs lines with matching keys", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n2 banana\n",
          "/b.txt": "2 yellow\n3 red\n"
        }
      });
      const result = await bash.exec("join /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("2 banana yellow\n");
    });

    it("handles many-to-many matches", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 a\n1 b\n",
          "/b.txt": "1 x\n1 y\n"
        }
      });
      const result = await bash.exec("join /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      // Each line from a matches each line from b with same key
      expect(result.stdout).toBe("1 a x\n1 a y\n1 b x\n1 b y\n");
    });

    it("reads from stdin with dash", async () => {
      const bash = new Bash({
        files: {
          "/b.txt": "1 red\n2 yellow\n"
        }
      });
      const result = await bash.exec(
        "printf '1 apple\\n2 banana\\n' | join - /b.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 apple red\n2 banana yellow\n");
    });
  });

  describe("-1 and -2 options", () => {
    it("joins on specified fields", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "apple 1\nbanana 2\n",
          "/b.txt": "1 red\n2 yellow\n"
        }
      });
      const result = await bash.exec("join -1 2 -2 1 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 apple red\n2 banana yellow\n");
    });

    it("errors on invalid field number", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "a\n",
          "/b.txt": "b\n"
        }
      });
      const result = await bash.exec("join -1 0 /a.txt /b.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid field number");
    });
  });

  describe("-t option (field separator)", () => {
    it("uses custom field separator", async () => {
      const bash = new Bash({
        files: {
          "/a.csv": "1,apple,fruit\n2,banana,fruit\n",
          "/b.csv": "1,red\n2,yellow\n"
        }
      });
      const result = await bash.exec("join -t ',' /a.csv /b.csv");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1,apple,fruit,red\n2,banana,fruit,yellow\n");
    });

    it("handles colon separator", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "user:1000:home\nroot:0:root\n",
          "/b.txt": "user:active\nroot:active\n"
        }
      });
      const result = await bash.exec("join -t ':' /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("user:1000:home:active\nroot:0:root:active\n");
    });
  });

  describe("-a option (print unpairable)", () => {
    it("prints unpairable lines from file 1", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n2 banana\n3 cherry\n",
          "/b.txt": "1 red\n3 red\n"
        }
      });
      const result = await bash.exec("join -a 1 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 apple red\n2 banana\n3 cherry red\n");
    });

    it("prints unpairable lines from file 2", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n",
          "/b.txt": "1 red\n2 yellow\n"
        }
      });
      const result = await bash.exec("join -a 2 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 apple red\n2 yellow\n");
    });

    it("prints unpairable from both files", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n2 banana\n",
          "/b.txt": "2 yellow\n3 red\n"
        }
      });
      const result = await bash.exec("join -a 1 -a 2 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 apple\n2 banana yellow\n3 red\n");
    });
  });

  describe("-v option (only unpairable)", () => {
    it("prints only unpairable lines from file 1", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n2 banana\n3 cherry\n",
          "/b.txt": "1 red\n3 red\n"
        }
      });
      const result = await bash.exec("join -v 1 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("2 banana\n");
    });

    it("prints only unpairable lines from file 2", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n",
          "/b.txt": "1 red\n2 yellow\n"
        }
      });
      const result = await bash.exec("join -v 2 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("2 yellow\n");
    });
  });

  describe("-e option (empty string)", () => {
    it("replaces missing fields with specified string", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n2 banana\n",
          "/b.txt": "1 red\n"
        }
      });
      const result = await bash.exec(
        "join -a 1 -e 'EMPTY' -o '1.1,1.2,2.2' /a.txt /b.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 apple red\n2 banana EMPTY\n");
    });
  });

  describe("-o option (output format)", () => {
    it("outputs specified fields", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple red\n2 banana yellow\n",
          "/b.txt": "1 fruit\n2 fruit\n"
        }
      });
      const result = await bash.exec("join -o '1.2,2.2' /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("apple fruit\nbanana fruit\n");
    });

    it("handles field 0 as join field", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "key val1\n",
          "/b.txt": "key val2\n"
        }
      });
      const result = await bash.exec("join -o '1.0,1.2,2.2' /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("key val1 val2\n");
    });

    it("errors on invalid format", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "a\n",
          "/b.txt": "b\n"
        }
      });
      const result = await bash.exec("join -o 'invalid' /a.txt /b.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid field spec");
    });
  });

  describe("-i option (ignore case)", () => {
    it("ignores case when comparing keys", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "Apple red\nBanana yellow\n",
          "/b.txt": "apple fruit\nbanana fruit\n"
        }
      });
      const result = await bash.exec("join -i /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("apple red fruit\nbanana yellow fruit\n");
    });
  });

  describe("edge cases", () => {
    it("handles empty files", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "",
          "/b.txt": "1 x\n"
        }
      });
      const result = await bash.exec("join /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("handles files with no matches", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "1 apple\n",
          "/b.txt": "2 banana\n"
        }
      });
      const result = await bash.exec("join /a.txt /b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("error handling", () => {
    it("errors when missing file operand", async () => {
      const bash = new Bash();
      const result = await bash.exec("join");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing file operand");
    });

    it("errors with only one file", async () => {
      const bash = new Bash({
        files: { "/a.txt": "1\n" }
      });
      const result = await bash.exec("join /a.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing file operand");
    });

    it("errors on unknown flag", async () => {
      const bash = new Bash();
      const result = await bash.exec("join -z /a.txt /b.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid option");
    });

    it("errors on missing file", async () => {
      const bash = new Bash({
        files: { "/a.txt": "1\n" }
      });
      const result = await bash.exec("join /a.txt /nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain(
        "no such file or directory"
      );
    });

    it("shows help with --help", async () => {
      const bash = new Bash();
      const result = await bash.exec("join --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("join");
      expect(result.stdout).toContain("Usage");
    });
  });
});
