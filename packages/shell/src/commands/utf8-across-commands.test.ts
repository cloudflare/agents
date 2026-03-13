/**
 * UTF-8 text preservation tests across commands.
 *
 * Verifies that non-ASCII characters (German umlauts, French accents, etc.)
 * are preserved correctly when flowing through various commands and file operations.
 *
 * Related: https://github.com/vercel-labs/just-bash/issues/131
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

// Latin-1 Supplement (U+0080–U+00FF) — the original bug range
// Latin Extended / Greek / Cyrillic (U+0100–U+04FF) — 2-byte UTF-8
// CJK Unified Ideographs (U+4E00–U+9FFF) — 3-byte UTF-8
// Emoji / Supplementary (U+1F600+) — 4-byte UTF-8 (surrogate pairs in JS)
const UTF8_TEXT = "Ü ö ß é ñ Ω Д 漢字 🎉";
const UTF8_CAFE = "café résumé naïve";

describe("UTF-8 text preservation across commands", () => {
  describe("tee", () => {
    it("should preserve UTF-8 text written by tee", async () => {
      const env = new Bash({});
      await env.exec(`echo "${UTF8_TEXT}" | tee /tmp/tee_out.txt > /dev/null`);
      const result = await env.exec("cat /tmp/tee_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 via tee with append mode", async () => {
      const env = new Bash({});
      await env.exec(`echo "line1" > /tmp/tee_append.txt`);
      await env.exec(
        `echo "${UTF8_CAFE}" | tee -a /tmp/tee_append.txt > /dev/null`
      );
      const result = await env.exec("cat /tmp/tee_append.txt");
      expect(result.stdout).toBe(`line1\n${UTF8_CAFE}\n`);
    });

    it("should preserve UTF-8 via tee readFileBuffer roundtrip", async () => {
      const env = new Bash({});
      await env.exec(`echo "Ü" | tee /tmp/tee_buf.txt > /dev/null`);
      const buffer = await env.fs.readFileBuffer("/tmp/tee_buf.txt");
      const decoded = new TextDecoder().decode(buffer);
      expect(decoded).toBe("Ü\n");
    });
  });

  describe("sort -o (output to file)", () => {
    it("should preserve UTF-8 text when sorting to file", async () => {
      const env = new Bash({});
      await env.exec('printf "Ü\\nÄ\\nÖ\\n" > /tmp/sort_in.txt');
      await env.exec("sort -o /tmp/sort_out.txt /tmp/sort_in.txt");
      const result = await env.exec("cat /tmp/sort_out.txt");
      // Verify all three UTF-8 characters are preserved (sort order is locale-dependent)
      expect(result.stdout).toContain("Ä");
      expect(result.stdout).toContain("Ö");
      expect(result.stdout).toContain("Ü");
      expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(3);
    });

    it("should preserve UTF-8 via sort -o readFileBuffer roundtrip", async () => {
      const env = new Bash({});
      await env.exec('printf "Ü\\n" > /tmp/sort_in2.txt');
      await env.exec("sort -o /tmp/sort_out2.txt /tmp/sort_in2.txt");
      const buffer = await env.fs.readFileBuffer("/tmp/sort_out2.txt");
      const decoded = new TextDecoder().decode(buffer);
      expect(decoded).toBe("Ü\n");
    });
  });

  describe("sed", () => {
    it("should preserve UTF-8 text through sed substitution", async () => {
      const env = new Bash({});
      const result = await env.exec("echo \"Ü Ö ß\" | sed 's/ß/ss/'");
      expect(result.stdout).toBe("Ü Ö ss\n");
    });

    it("should preserve UTF-8 in sed output redirect", async () => {
      const env = new Bash({});
      await env.exec("echo \"café résumé\" | sed 's/é/e/g' > /tmp/sed_out.txt");
      const result = await env.exec("cat /tmp/sed_out.txt");
      expect(result.stdout).toBe("cafe resume\n");
    });

    it("should preserve UTF-8 through sed w command", async () => {
      const env = new Bash({});
      await env.exec(
        `echo "${UTF8_TEXT}" | sed 'w /tmp/sed_w_out.txt' > /dev/null`
      );
      const result = await env.exec("cat /tmp/sed_w_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });
  });

  describe("awk", () => {
    it("should preserve UTF-8 text through awk passthrough", async () => {
      const env = new Bash({});
      const result = await env.exec(`echo "${UTF8_TEXT}" | awk '{print $0}'`);
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 in awk output redirect", async () => {
      const env = new Bash({});
      await env.exec(
        `echo "${UTF8_TEXT}" | awk '{print $0}' > /tmp/awk_out.txt`
      );
      const result = await env.exec("cat /tmp/awk_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 in awk print > file", async () => {
      const env = new Bash({});
      await env.exec(
        `echo "${UTF8_CAFE}" | awk '{print > "/tmp/awk_redir.txt"}'`
      );
      const result = await env.exec("cat /tmp/awk_redir.txt");
      expect(result.stdout).toBe(`${UTF8_CAFE}\n`);
    });
  });

  describe("printf", () => {
    it("should preserve UTF-8 text with printf redirect", async () => {
      const env = new Bash({});
      await env.exec(`printf "%s\\n" "${UTF8_TEXT}" > /tmp/printf_out.txt`);
      const result = await env.exec("cat /tmp/printf_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 via printf readFileBuffer roundtrip", async () => {
      const env = new Bash({});
      await env.exec('printf "Ü" > /tmp/printf_buf.txt');
      const buffer = await env.fs.readFileBuffer("/tmp/printf_buf.txt");
      const decoded = new TextDecoder().decode(buffer);
      expect(decoded).toBe("Ü");
    });
  });

  describe("heredoc", () => {
    it("should preserve UTF-8 text in heredoc redirect", async () => {
      const env = new Bash({});
      await env.exec(`cat << 'EOF' > /tmp/heredoc_out.txt
${UTF8_TEXT}
EOF`);
      const result = await env.exec("cat /tmp/heredoc_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 via heredoc readFileBuffer roundtrip", async () => {
      const env = new Bash({});
      await env.exec(`cat << 'EOF' > /tmp/heredoc_buf.txt
Ü
EOF`);
      const buffer = await env.fs.readFileBuffer("/tmp/heredoc_buf.txt");
      const decoded = new TextDecoder().decode(buffer);
      expect(decoded).toBe("Ü\n");
    });
  });

  describe("here-string", () => {
    it("should preserve UTF-8 text in here-string redirect", async () => {
      const env = new Bash({});
      await env.exec(`cat <<< "${UTF8_TEXT}" > /tmp/herestr_out.txt`);
      const result = await env.exec("cat /tmp/herestr_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });
  });

  describe("variable roundtrip", () => {
    it("should preserve UTF-8 in variable assignment and echo redirect", async () => {
      const env = new Bash({});
      await env.exec(`x="${UTF8_TEXT}"; echo "$x" > /tmp/var_out.txt`);
      const result = await env.exec("cat /tmp/var_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 via variable readFileBuffer roundtrip", async () => {
      const env = new Bash({});
      await env.exec('x="Ü"; echo "$x" > /tmp/var_buf.txt');
      const buffer = await env.fs.readFileBuffer("/tmp/var_buf.txt");
      const decoded = new TextDecoder().decode(buffer);
      expect(decoded).toBe("Ü\n");
    });
  });

  describe("command substitution", () => {
    it("should preserve UTF-8 through command substitution", async () => {
      const env = new Bash({});
      const result = await env.exec(`x=$(echo "${UTF8_TEXT}"); echo "$x"`);
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 through command sub to file", async () => {
      const env = new Bash({});
      await env.exec(
        `x=$(echo "${UTF8_TEXT}"); echo "$x" > /tmp/cmdsub_out.txt`
      );
      const result = await env.exec("cat /tmp/cmdsub_out.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });
  });

  describe("pipeline combinations", () => {
    it("should preserve UTF-8 through grep pipeline", async () => {
      const env = new Bash({});
      const result = await env.exec(`echo "${UTF8_TEXT}" | grep -o "Ü"`);
      expect(result.stdout).toBe("Ü\n");
    });

    it("should preserve UTF-8 through multiple pipe stages", async () => {
      const env = new Bash({});
      const result = await env.exec(
        "echo 'café résumé' | sed 's/é/e/g' | tr 'a-z' 'A-Z'"
      );
      expect(result.stdout).toBe("CAFE RESUME\n");
    });

    it("should preserve UTF-8 through sort | uniq pipeline", async () => {
      const env = new Bash({});
      const result = await env.exec(
        'printf "Ü\\nÄ\\nÜ\\nÖ\\nÄ\\n" | sort | uniq'
      );
      expect(result.stdout).toBe("Ä\nÖ\nÜ\n");
    });

    it("should preserve UTF-8 through cut pipeline", async () => {
      const env = new Bash({});
      const result = await env.exec(`echo "Ü:Ö:Ä" | cut -d: -f2`);
      expect(result.stdout).toBe("Ö\n");
    });
  });

  describe("file operations with UTF-8 filenames/content", () => {
    it("should handle UTF-8 in file content via cp", async () => {
      const env = new Bash({
        files: { "/src.txt": `${UTF8_TEXT}\n` }
      });
      await env.exec("cp /src.txt /dst.txt");
      const result = await env.exec("cat /dst.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 through head", async () => {
      const env = new Bash({
        files: { "/utf8.txt": `${UTF8_TEXT}\nline2\n` }
      });
      const result = await env.exec("head -1 /utf8.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 through tail", async () => {
      const env = new Bash({
        files: { "/utf8.txt": `line1\n${UTF8_TEXT}\n` }
      });
      const result = await env.exec("tail -1 /utf8.txt");
      expect(result.stdout).toBe(`${UTF8_TEXT}\n`);
    });

    it("should preserve UTF-8 through wc", async () => {
      const env = new Bash({
        files: { "/utf8.txt": `${UTF8_TEXT}\n` }
      });
      const result = await env.exec("wc -l /utf8.txt");
      expect(result.stdout.trim()).toContain("1");
    });
  });

  describe("split command", () => {
    it("should preserve UTF-8 through split and reassembly", async () => {
      const env = new Bash({
        files: {
          "/split_in.txt": "Ü\nÖ\nÄ\n"
        }
      });
      await env.exec("split -l 1 /split_in.txt /tmp/chunk_");
      const result = await env.exec(
        "cat /tmp/chunk_aa /tmp/chunk_ab /tmp/chunk_ac"
      );
      expect(result.stdout).toBe("Ü\nÖ\nÄ\n");
    });
  });
});
