/**
 * Pipeline and Redirection Limits
 *
 * Tests for pipeline execution, file descriptor handling,
 * and redirection behavior.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("Pipeline and Redirection Limits", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
  });

  describe("Pipeline Execution", () => {
    it("should execute basic pipelines", async () => {
      const result = await bash.exec("echo hello | cat");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });

    it("should execute multi-stage pipelines", async () => {
      const result = await bash.exec("echo hello | cat | cat | cat");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });

    it("should enforce command count limit across commands", async () => {
      const limitedBash = new Bash({
        executionLimits: { maxCommandCount: 5 }
      });

      // Run multiple commands to hit the limit
      const result = await limitedBash.exec(`
        echo a
        echo b
        echo c
        echo d
        echo e
        echo f
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many commands executed");
    });
  });

  describe("File Descriptor Handling", () => {
    it("should handle many redirections in sequence", async () => {
      const result = await bash.exec(`
        echo "test" > /tmp/fd1.txt
        echo "test" > /tmp/fd2.txt
        echo "test" > /tmp/fd3.txt
        echo "test" > /tmp/fd4.txt
        echo "test" > /tmp/fd5.txt
        cat /tmp/fd1.txt /tmp/fd2.txt /tmp/fd3.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\ntest\ntest\n");
    });

    it("should clean up FDs after command completion", async () => {
      const result = await bash.exec(`
        exec 3>/tmp/fdtest.txt
        echo "line1" >&3
        exec 3>&-
        echo "done"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("done\n");
    });

    it("should handle FD numbers within valid range", async () => {
      const result = await bash.exec(`
        exec 9>/tmp/fd9.txt
        echo "test" >&9
        exec 9>&-
        cat /tmp/fd9.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });
  });

  describe("Here Documents", () => {
    it("should handle multiple heredocs", async () => {
      const result = await bash.exec(`
        cat <<EOF1
First heredoc
EOF1
        cat <<EOF2
Second heredoc
EOF2
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("First heredoc\nSecond heredoc\n");
    });

    it("should handle heredocs with variable expansion", async () => {
      const result = await bash.exec(`
        name="world"
        cat <<EOF
Hello $name
EOF
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello world\n");
    });

    it("should handle heredocs with quoted delimiter (no expansion)", async () => {
      const result = await bash.exec(`
        name="world"
        cat <<'EOF'
Hello $name
EOF
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello $name\n");
    });
  });

  describe("Redirection Chains", () => {
    it("should handle output redirection chains", async () => {
      const result = await bash.exec(`
        echo "test" > /tmp/redir1.txt
        cat /tmp/redir1.txt > /tmp/redir2.txt
        cat /tmp/redir2.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test\n");
    });

    it("should handle append redirections", async () => {
      const result = await bash.exec(`
        echo "line1" > /tmp/append.txt
        echo "line2" >> /tmp/append.txt
        echo "line3" >> /tmp/append.txt
        cat /tmp/append.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("line1\nline2\nline3\n");
    });

    it("should handle stderr redirection", async () => {
      const result = await bash.exec(`
        echo "error message" >&2
        echo "normal output"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("normal output\n");
      expect(result.stderr).toBe("error message\n");
    });

    it("should handle combined redirections", async () => {
      const result = await bash.exec(`
        { echo "stdout"; echo "stderr" >&2; } > /tmp/combined.txt 2>&1
        cat /tmp/combined.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("stdout");
      expect(result.stdout).toContain("stderr");
    });
  });

  describe("Pipeline Patterns", () => {
    it("should handle pipeline with command groups", async () => {
      const result = await bash.exec(`
        { echo "a"; echo "b"; } | { cat; echo "c"; }
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should handle subshell in pipeline", async () => {
      const result = await bash.exec(`
        (echo "from subshell") | cat
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("from subshell\n");
    });

    it("should handle pipestatus array", async () => {
      const result = await bash.exec(`
        false | true | false
        echo "\${PIPESTATUS[@]}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1 0 1\n");
    });
  });

  describe("Data Through Pipelines", () => {
    it("should pass data through multiple stages", async () => {
      const result = await bash.exec(`
        echo "hello world" | tr 'a-z' 'A-Z' | cat
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("HELLO WORLD\n");
    });

    it("should handle empty pipeline input", async () => {
      const result = await bash.exec(`
        echo -n "" | cat
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("should handle newlines in pipeline", async () => {
      const result = await bash.exec(`
        printf "line1\\nline2\\nline3\\n" | cat
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("line1\nline2\nline3\n");
    });
  });

  describe("Process Substitution", () => {
    it.skip("should handle basic process substitution syntax", async () => {
      // Process substitution <() is not fully supported yet
      // Skip this test until implementation is complete
      const result = await bash.exec(`
        echo <(echo hello)
      `);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Pipeline Error Handling", () => {
    it("should propagate exit codes in pipeline", async () => {
      const result = await bash.exec(`
        true | false
        echo $?
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n");
    });

    it("should handle pipefail option", async () => {
      const result = await bash.exec(`
        set -o pipefail
        false | true
        echo $?
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n");
    });
  });

  describe("Input Redirection", () => {
    it("should handle input redirection from file", async () => {
      const result = await bash.exec(`
        echo "file content" > /tmp/input.txt
        cat < /tmp/input.txt
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("file content\n");
    });

    it("should handle here-string", async () => {
      const result = await bash.exec(`
        cat <<< "hello from here-string"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello from here-string\n");
    });
  });
});
