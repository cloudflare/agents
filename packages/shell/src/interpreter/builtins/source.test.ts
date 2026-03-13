import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("source builtin", () => {
  describe("basic source", () => {
    it("should execute commands from file in current environment", async () => {
      const env = new Bash();
      await env.exec('echo "x=123" > /tmp/test.sh');
      const result = await env.exec(`
        source /tmp/test.sh
        echo "x is: $x"
      `);
      expect(result.stdout).toBe("x is: 123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support functions from sourced file", async () => {
      const env = new Bash();
      await env.exec('echo "greet() { echo Hello \\$1; }" > /tmp/funcs.sh');
      const result = await env.exec(`
        source /tmp/funcs.sh
        greet World
      `);
      expect(result.stdout).toBe("Hello World\n");
      expect(result.exitCode).toBe(0);
    });

    it("should modify variables in caller environment", async () => {
      const env = new Bash();
      await env.exec('echo "VAR=modified" > /tmp/modify.sh');
      const result = await env.exec(`
        VAR=original
        source /tmp/modify.sh
        echo $VAR
      `);
      expect(result.stdout).toBe("modified\n");
    });

    it("should support multiple commands in sourced file", async () => {
      const env = new Bash();
      await env.exec(`
        cat > /tmp/multi.sh << 'EOF'
A=1
B=2
C=$((A + B))
EOF
      `);
      const result = await env.exec(`
        source /tmp/multi.sh
        echo $A $B $C
      `);
      expect(result.stdout).toBe("1 2 3\n");
    });
  });

  describe(". (dot) builtin", () => {
    it("should work same as source", async () => {
      const env = new Bash();
      await env.exec('echo "y=456" > /tmp/test2.sh');
      const result = await env.exec(`
        . /tmp/test2.sh
        echo "y is: $y"
      `);
      expect(result.stdout).toBe("y is: 456\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle functions with . syntax", async () => {
      const env = new Bash();
      await env.exec('echo "add() { echo \\$((\\$1 + \\$2)); }" > /tmp/add.sh');
      const result = await env.exec(`
        . /tmp/add.sh
        add 3 4
      `);
      expect(result.stdout).toBe("7\n");
    });
  });

  describe("sourced script with arguments", () => {
    it("should pass arguments to sourced script", async () => {
      const env = new Bash();
      await env.exec('echo "echo args: \\$1 \\$2 \\$#" > /tmp/args.sh');
      const result = await env.exec("source /tmp/args.sh foo bar");
      expect(result.stdout).toBe("args: foo bar 2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should restore arguments after sourcing", async () => {
      const env = new Bash();
      await env.exec('echo "echo sourced: \\$1" > /tmp/sourced.sh');
      const result = await env.exec(`
        myfunc() {
          echo "func: $1"
          source /tmp/sourced.sh arg
          echo "after: $1"
        }
        myfunc original
      `);
      expect(result.stdout).toBe(
        "func: original\nsourced: arg\nafter: original\n"
      );
    });
  });

  describe("error cases", () => {
    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("source /nonexistent/file.sh");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });

    it("should error with no arguments", async () => {
      const env = new Bash();
      const result = await env.exec("source");
      expect(result.stderr).toContain("filename argument required");
      expect(result.exitCode).toBe(2);
    });

    it("should error with . and no arguments", async () => {
      const env = new Bash();
      const result = await env.exec(".");
      expect(result.stderr).toContain("filename argument required");
      expect(result.exitCode).toBe(2);
    });
  });

  describe("sandbox isolation", () => {
    it("should not access real /etc/passwd via source", async () => {
      const env = new Bash();
      const result = await env.exec("source /etc/passwd");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });

    it("should not access real files outside VFS via source", async () => {
      const env = new Bash();
      const result = await env.exec("source /etc/hosts");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("return in sourced script", () => {
    it("should support return in sourced script", async () => {
      const env = new Bash();
      await env.exec(`
        cat > /tmp/early.sh << 'EOF'
echo before
return 0
echo after
EOF
      `);
      const result = await env.exec(`
        source /tmp/early.sh
        echo done
      `);
      expect(result.stdout).toBe("before\ndone\n");
    });

    it("should propagate return exit code", async () => {
      const env = new Bash();
      await env.exec('echo "return 42" > /tmp/exit.sh');
      const result = await env.exec(`
        source /tmp/exit.sh
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("exit: 42\n");
    });
  });
});
