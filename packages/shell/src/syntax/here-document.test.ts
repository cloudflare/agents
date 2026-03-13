import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Here Documents <<EOF", () => {
  it("should pass here document content as stdin to cat", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF
hello world
EOF`);
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle multiple lines", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<END
line 1
line 2
line 3
END`);
    expect(result.stdout).toBe("line 1\nline 2\nline 3\n");
    expect(result.exitCode).toBe(0);
  });

  it("should expand variables in here document", async () => {
    const env = new Bash({ env: { NAME: "Alice" } });
    const result = await env.exec(`cat <<EOF
Hello, $NAME!
EOF`);
    expect(result.stdout).toBe("Hello, Alice!\n");
    expect(result.exitCode).toBe(0);
  });

  it("should NOT expand variables when delimiter is quoted", async () => {
    const env = new Bash({ env: { NAME: "Alice" } });
    const result = await env.exec(`cat <<'EOF'
Hello, $NAME!
EOF`);
    expect(result.stdout).toBe("Hello, $NAME!\n");
    expect(result.exitCode).toBe(0);
  });

  it("should work with double-quoted delimiter", async () => {
    const env = new Bash({ env: { NAME: "Alice" } });
    const result = await env.exec(`cat <<"EOF"
Hello, $NAME!
EOF`);
    expect(result.stdout).toBe("Hello, $NAME!\n");
    expect(result.exitCode).toBe(0);
  });

  it("should work with wc command", async () => {
    const env = new Bash();
    const result = await env.exec(`wc -l <<EOF
one
two
three
EOF`);
    expect(result.stdout.trim()).toBe("3");
    expect(result.exitCode).toBe(0);
  });

  it("should work with grep", async () => {
    const env = new Bash();
    const result = await env.exec(`grep world <<EOF
hello world
goodbye world
just hello
EOF`);
    expect(result.stdout).toBe("hello world\ngoodbye world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle empty here document", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF
EOF`);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle here document with empty line", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF

EOF`);
    expect(result.stdout).toBe("\n");
    expect(result.exitCode).toBe(0);
  });

  it("should work in pipes", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF | grep hello
hello world
goodbye world
EOF`);
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle different delimiters", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<MYDELIM
content here
MYDELIM`);
    expect(result.stdout).toBe("content here\n");
    expect(result.exitCode).toBe(0);
  });

  it("should expand command substitution in here document", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF
Today is $(echo wonderful)
EOF`);
    expect(result.stdout).toBe("Today is wonderful\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle multiple commands with here document", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF
hello
EOF
echo done`);
    expect(result.stdout).toBe("hello\ndone\n");
    expect(result.exitCode).toBe(0);
  });

  it("should not perform brace expansion in heredoc content", async () => {
    const env = new Bash();
    const result = await env.exec(`cat <<EOF
{a,b}
EOF`);
    expect(result.stdout).toBe("{a,b}\n");
    expect(result.exitCode).toBe(0);
  });

  describe("whitespace preservation", () => {
    it("should preserve leading spaces in here document content", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF
    four spaces at start
  two spaces at start
no spaces
EOF`);
      expect(result.stdout).toBe(
        "    four spaces at start\n  two spaces at start\nno spaces\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should preserve leading tabs in here document content (not <<-)", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF
\tleading tab
no tab
EOF`);
      expect(result.stdout).toBe("\tleading tab\nno tab\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve mixed whitespace in here document", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<EOF
  spaces
\ttab
  \tmixed
EOF`);
      expect(result.stdout).toBe("  spaces\n\ttab\n  \tmixed\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve whitespace even when script is indented", async () => {
      const env = new Bash();
      // This tests that the script normalization doesn't strip heredoc content
      const result = await env.exec(`
        cat <<EOF
    indented content
        more indented
EOF
      `);
      expect(result.stdout).toBe(
        "    indented content\n        more indented\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should preserve ASCII art triangle with leading spaces", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<'EOF'
                    *
                   * *
                  *   *
                 *     *
                *       *
               *         *
              *           *
             *             *
            *               *
           *                 *
          *                   *
         *********************
EOF`);
      expect(result.stdout).toBe(`                    *
                   * *
                  *   *
                 *     *
                *       *
               *         *
              *           *
             *             *
            *               *
           *                 *
          *                   *
         *********************
`);
      expect(result.exitCode).toBe(0);
    });

    it("should not treat indented delimiter as end of heredoc", async () => {
      const env = new Bash();
      // A line with "  EOF" (spaces before EOF) should be content, not delimiter
      const result = await env.exec(`cat <<EOF
line 1
  EOF
line 2
EOF`);
      expect(result.stdout).toBe("line 1\n  EOF\nline 2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle delimiter with hyphen", async () => {
      const env = new Bash();
      const result = await env.exec(`cat <<END-TEST
  content with spaces
END-TEST`);
      expect(result.stdout).toBe("  content with spaces\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
