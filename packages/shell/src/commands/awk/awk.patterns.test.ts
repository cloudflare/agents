import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk patterns", () => {
  describe("regex patterns", () => {
    it("should match literal regex", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\ncherry\n" }
      });
      const result = await env.exec(`awk '/ana/' /data.txt`);
      expect(result.stdout).toBe("banana\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match beginning of line with ^", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\n" }
      });
      const result = await env.exec(`awk '/^a/' /data.txt`);
      expect(result.stdout).toBe("apple\napricot\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match end of line with $", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello\nworld\nfellow\n" }
      });
      const result = await env.exec(`awk '/llo$/' /data.txt`);
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match character class", async () => {
      const env = new Bash({
        files: { "/data.txt": "cat\ndog\ncow\n" }
      });
      const result = await env.exec(`awk '/[cd]/' /data.txt`);
      expect(result.stdout).toBe("cat\ndog\ncow\n");
      expect(result.exitCode).toBe(0);
    });

    it("should negate character class with [^]", async () => {
      const env = new Bash({
        files: { "/data.txt": "abc\nxyz\n123\n" }
      });
      const result = await env.exec(`awk '/[^a-z]/' /data.txt`);
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with alternation", async () => {
      const env = new Bash({
        files: { "/data.txt": "red\ngreen\nblue\nyellow\n" }
      });
      const result = await env.exec(`awk '/red|blue/' /data.txt`);
      expect(result.stdout).toBe("red\nblue\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with quantifiers", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\naa\naaa\naaaa\n" }
      });
      const result = await env.exec(`awk '/a{2,3}/' /data.txt`);
      expect(result.stdout).toBe("aa\naaa\naaaa\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("expression patterns", () => {
    it("should match with equality", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(`awk '$1 == 2' /data.txt`);
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with inequality", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(`awk '$1 != 2' /data.txt`);
      expect(result.stdout).toBe("1\n3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with greater than", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n20\n30\n40\n" }
      });
      const result = await env.exec(`awk '$1 > 25' /data.txt`);
      expect(result.stdout).toBe("30\n40\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with less than", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n20\n30\n40\n" }
      });
      const result = await env.exec(`awk '$1 < 25' /data.txt`);
      expect(result.stdout).toBe("10\n20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match string comparison", async () => {
      const env = new Bash({
        files: { "/data.txt": "alice\nbob\ncharlie\n" }
      });
      const result = await env.exec(`awk '$1 == "bob"' /data.txt`);
      expect(result.stdout).toBe("bob\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match lexicographic comparison", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\ncherry\n" }
      });
      const result = await env.exec(`awk '$1 < "c"' /data.txt`);
      expect(result.stdout).toBe("apple\nbanana\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined patterns", () => {
    it("should match with AND", async () => {
      const env = new Bash({
        files: { "/data.txt": "1 a\n2 b\n3 a\n4 b\n" }
      });
      const result = await env.exec(`awk '$1 > 1 && $2 == "a"' /data.txt`);
      expect(result.stdout).toBe("3 a\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with OR", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n4\n5\n" }
      });
      const result = await env.exec(`awk '$1 == 1 || $1 == 5' /data.txt`);
      expect(result.stdout).toBe("1\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match with NOT", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(`awk '!($1 == 2)' /data.txt`);
      expect(result.stdout).toBe("1\n3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine regex and expression", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple 10\nbanana 20\napricot 5\n" }
      });
      const result = await env.exec(`awk '/^a/ && $2 > 5' /data.txt`);
      expect(result.stdout).toBe("apple 10\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("NR patterns", () => {
    it("should match first line", async () => {
      const env = new Bash({
        files: { "/data.txt": "header\nline1\nline2\n" }
      });
      const result = await env.exec(`awk 'NR == 1' /data.txt`);
      expect(result.stdout).toBe("header\n");
      expect(result.exitCode).toBe(0);
    });

    it("should skip first line", async () => {
      const env = new Bash({
        files: { "/data.txt": "header\nline1\nline2\n" }
      });
      const result = await env.exec(`awk 'NR > 1' /data.txt`);
      expect(result.stdout).toBe("line1\nline2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match range of lines", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n4\n5\n" }
      });
      const result = await env.exec(`awk 'NR >= 2 && NR <= 4' /data.txt`);
      expect(result.stdout).toBe("2\n3\n4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match every Nth line", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\nd\ne\nf\n" }
      });
      const result = await env.exec(`awk 'NR % 2 == 1' /data.txt`);
      expect(result.stdout).toBe("a\nc\ne\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("field regex match patterns", () => {
    it("should match field with regex using ~", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple red\nbanana yellow\napricot orange\n" }
      });
      const result = await env.exec(`awk '$1 ~ /^a/' /data.txt`);
      expect(result.stdout).toBe("apple red\napricot orange\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not match with !~", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple red\nbanana yellow\napricot orange\n" }
      });
      const result = await env.exec(`awk '$1 !~ /^a/' /data.txt`);
      expect(result.stdout).toBe("banana yellow\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match second field", async () => {
      const env = new Bash({
        files: { "/data.txt": "fruit apple\nveg carrot\nfruit banana\n" }
      });
      const result = await env.exec(`awk '$2 ~ /^a/' /data.txt`);
      expect(result.stdout).toBe("fruit apple\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("empty pattern", () => {
    it("should match all lines without pattern", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(`awk '{ print "line:", $0 }' /data.txt`);
      expect(result.stdout).toBe("line: a\nline: b\nline: c\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("pattern-only rules", () => {
    it("should print matching line with pattern only", async () => {
      const env = new Bash({
        files: { "/data.txt": "yes\nno\nyes\n" }
      });
      const result = await env.exec(`awk '/yes/' /data.txt`);
      expect(result.stdout).toBe("yes\nyes\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
