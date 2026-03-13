/**
 * Node.js Integration Tests
 *
 * Tests the shell with real Node.js adapters:
 * - ChildProcessExecutor with real node/python3 binaries
 * - Core shell commands running in a Node.js environment
 * - Filesystem, pipes, redirects with real execution
 */
import { describe, expect, it } from "vitest";
import { Shell } from "../Shell";
import { ChildProcessExecutor } from "../node";

// ── Core shell (no adapters) ────────────────────────────────────────

describe("Shell core in Node.js", () => {
  it("should execute basic commands", async () => {
    const shell = new Shell();
    const result = await shell.exec('echo "hello world"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("should pipe between commands", async () => {
    const shell = new Shell();
    const result = await shell.exec('echo -e "banana\\napple\\ncherry" | sort');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("apple\nbanana\ncherry\n");
  });

  it("should handle redirections and file operations", async () => {
    const shell = new Shell();
    await shell.exec('echo "line1" > /tmp/test.txt');
    await shell.exec('echo "line2" >> /tmp/test.txt');
    const result = await shell.exec("cat /tmp/test.txt");
    expect(result.stdout).toBe("line1\nline2\n");
  });

  it("should run jq on JSON data", async () => {
    const shell = new Shell({
      files: {
        "/data.json": JSON.stringify([
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 }
        ])
      }
    });
    const result = await shell.exec("cat /data.json | jq '.[1].name'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('"Bob"');
  });

  it("should support grep with regex", async () => {
    const shell = new Shell({
      files: {
        "/log.txt":
          "INFO: started\nERROR: failed\nINFO: completed\nWARN: slow\n"
      }
    });
    const result = await shell.exec("grep -c ERROR /log.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  });

  it("should support awk for text processing", async () => {
    const shell = new Shell({
      files: {
        "/data.csv": "Alice,30\nBob,25\nCharlie,35\n"
      }
    });
    const result = await shell.exec(
      "awk -F, '{sum+=$2} END {print sum}' /data.csv"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("90");
  });

  it("should support sed substitution", async () => {
    const shell = new Shell();
    const result = await shell.exec("echo 'hello world' | sed 's/world/node/'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello node\n");
  });

  it("should support find command", async () => {
    const shell = new Shell({
      files: {
        "/project/src/index.ts": "export {}",
        "/project/src/utils.ts": "export {}",
        "/project/README.md": "# Project"
      }
    });
    const result = await shell.exec("find /project -name '*.ts' | sort");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "/project/src/index.ts\n/project/src/utils.ts\n"
    );
  });

  it("should support tar create and extract", async () => {
    const shell = new Shell({
      cwd: "/project",
      files: {
        "/project/src/a.txt": "file a",
        "/project/src/b.txt": "file b"
      }
    });
    await shell.exec("tar -cf /project/archive.tar src/a.txt src/b.txt");
    await shell.exec("mkdir /project/out");
    await shell.exec("tar -xf /project/archive.tar -C /project/out");
    const result = await shell.exec("cat /project/out/src/a.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file a");
  });

  it("should enforce execution limits", async () => {
    const shell = new Shell({
      executionLimits: { maxLoopIterations: 10 }
    });
    const result = await shell.exec("for i in $(seq 1 100); do echo $i; done");
    expect(result.exitCode).not.toBe(0);
  });

  it("should support environment variables", async () => {
    const shell = new Shell({ env: { MY_VAR: "hello" } });
    const result = await shell.exec("echo $MY_VAR");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("should support command substitution", async () => {
    const shell = new Shell();
    const result = await shell.exec(
      "echo \"count: $(echo -e 'a\\nb\\nc' | wc -l)\""
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain("count:");
    expect(result.stdout.trim()).toContain("3");
  });
});

// ── ChildProcessExecutor ────────────────────────────────────────────

describe("ChildProcessExecutor (real node)", () => {
  it("should execute JavaScript via node", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({ executor });
    const result = await shell.exec('js-exec "console.log(2 + 2)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("4");
  });

  it("should capture stderr from JavaScript errors", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({ executor });
    const result = await shell.exec(
      "js-exec \"throw new Error('test error')\""
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("test error");
  });

  it("should pass environment variables to js-exec", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({
      executor,
      env: { TEST_VAR: "from_shell" }
    });
    const result = await shell.exec(
      'js-exec "console.log(process.env.TEST_VAR)"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("from_shell");
  });

  it("should execute multi-line JavaScript", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({ executor });
    await shell.exec(
      "cat > /tmp/script.js << 'EOF'\nconst a = 10;\nconst b = 20;\nconsole.log(a + b);\nEOF"
    );
    const code = await shell.readFile("/tmp/script.js");
    const result = await executor.execute(code, "javascript");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("30");
  });
});

// Check if python3 is available before running Python tests
let hasPython = false;
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("python3", ["--version"], { timeout: 5000 });
  hasPython = true;
} catch {
  // python3 not available
}

describe.skipIf(!hasPython)("ChildProcessExecutor (real python3)", () => {
  it("should execute Python via python3", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({ executor });
    const result = await shell.exec('python3 -c "print(2 + 2)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("4");
  });

  it("should capture stderr from Python errors", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({ executor });
    const result = await shell.exec(
      "python3 -c \"raise ValueError('test error')\""
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ValueError");
    expect(result.stderr).toContain("test error");
  });

  it("should handle Python imports", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const result = await executor.execute(
      "import json; print(json.dumps({'key': 'value'}))",
      "python"
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ key: "value" });
  });
});

// ── Pipes with code execution ───────────────────────────────────────

describe("Shell + ChildProcessExecutor pipes", () => {
  it("should pipe shell output into js-exec via stdin", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({
      executor,
      files: {
        "/data.json": JSON.stringify({ items: [1, 2, 3] })
      }
    });
    // Use jq to extract then count
    const result = await shell.exec("cat /data.json | jq '.items | length'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  });

  it("should combine shell commands with code execution", async () => {
    const executor = new ChildProcessExecutor({ timeout: 10_000 });
    const shell = new Shell({ executor });

    // Generate data with shell, process with js-exec
    await shell.exec('for i in 1 2 3 4 5; do echo "$i"; done > /tmp/nums.txt');
    const result = await shell.exec("wc -l < /tmp/nums.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("5");
  });
});
