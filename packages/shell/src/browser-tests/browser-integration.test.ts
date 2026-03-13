/**
 * Browser Integration Tests
 *
 * Tests the shell running in a real browser environment via Playwright.
 * Verifies that the core shell and embedded adapters work without
 * Node.js APIs (no child_process, no node:dns, etc.).
 */
import { describe, expect, it } from "vitest";
import { Shell } from "../Shell";

// ── Core shell in browser ───────────────────────────────────────────

describe("Shell core in browser", () => {
  it("should execute basic echo", async () => {
    const shell = new Shell();
    const result = await shell.exec('echo "hello from browser"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from browser\n");
  });

  it("should pipe between commands", async () => {
    const shell = new Shell();
    const result = await shell.exec('echo -e "cherry\\napple\\nbanana" | sort');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("apple\nbanana\ncherry\n");
  });

  it("should write and read files", async () => {
    const shell = new Shell();
    await shell.exec('echo "browser test" > /tmp/browser.txt');
    const result = await shell.exec("cat /tmp/browser.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("browser test\n");
  });

  it("should handle jq processing", async () => {
    const shell = new Shell({
      files: {
        "/data.json": JSON.stringify({ name: "browser", version: 1 })
      }
    });
    const result = await shell.exec("cat /data.json | jq '.name'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('"browser"');
  });

  it("should handle grep", async () => {
    const shell = new Shell({
      files: {
        "/log.txt": "INFO: start\nERROR: fail\nINFO: end\nERROR: crash\n"
      }
    });
    const result = await shell.exec("grep ERROR /log.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ERROR: fail\nERROR: crash\n");
  });

  it("should handle sed", async () => {
    const shell = new Shell();
    const result = await shell.exec(
      "echo 'hello world' | sed 's/world/browser/'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello browser\n");
  });

  it("should handle awk", async () => {
    const shell = new Shell();
    const result = await shell.exec(
      "echo -e '1\\n2\\n3' | awk '{s+=$1} END {print s}'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("6");
  });

  it("should handle environment variables", async () => {
    const shell = new Shell({ env: { BROWSER: "true" } });
    const result = await shell.exec("echo $BROWSER");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("true\n");
  });

  it("should handle for loops", async () => {
    const shell = new Shell();
    const result = await shell.exec('for i in a b c; do echo "$i"; done');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should handle functions", async () => {
    const shell = new Shell();
    const result = await shell.exec('greet() { echo "hi $1"; }; greet browser');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi browser\n");
  });

  it("should handle command substitution", async () => {
    const shell = new Shell();
    const result = await shell.exec(
      'echo "files: $(echo -e "a\\nb\\nc" | wc -l)"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain("3");
  });

  it("should handle heredocs", async () => {
    const shell = new Shell();
    const result = await shell.exec("cat << EOF\nhello\nworld\nEOF");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\nworld\n");
  });

  it("should handle arrays", async () => {
    const shell = new Shell();
    const result = await shell.exec('arr=(one two three); echo "${arr[1]}"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("two\n");
  });

  it("should handle base64 encoding/decoding", async () => {
    const shell = new Shell();
    const encode = await shell.exec("echo -n 'hello' | base64");
    expect(encode.exitCode).toBe(0);
    const encoded = encode.stdout.trim();

    const decode = await shell.exec(`echo -n '${encoded}' | base64 -d`);
    expect(decode.exitCode).toBe(0);
    expect(decode.stdout).toBe("hello");
  });

  it("should handle find command", async () => {
    const shell = new Shell({
      files: {
        "/proj/a.ts": "",
        "/proj/b.ts": "",
        "/proj/c.md": ""
      }
    });
    const result = await shell.exec("find /proj -name '*.ts' | sort");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/proj/a.ts\n/proj/b.ts\n");
  });

  it("should enforce execution limits", async () => {
    const shell = new Shell({
      executionLimits: { maxLoopIterations: 5 }
    });
    const result = await shell.exec("i=0; while true; do i=$((i+1)); done");
    expect(result.exitCode).not.toBe(0);
  });

  it("should handle custom commands", async () => {
    const shell = new Shell({
      customCommands: [
        {
          name: "browser-info",
          execute: async () => ({
            stdout: "running in browser\n",
            stderr: "",
            exitCode: 0
          })
        }
      ]
    });
    const result = await shell.exec("browser-info");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("running in browser\n");
  });
});

// ── In-memory filesystem in browser ─────────────────────────────────

describe("InMemoryFs in browser", () => {
  it("should support initial files", async () => {
    const shell = new Shell({
      files: {
        "/a.txt": "aaa",
        "/dir/b.txt": "bbb"
      }
    });
    const a = await shell.exec("cat /a.txt");
    expect(a.stdout).toBe("aaa");

    const b = await shell.exec("cat /dir/b.txt");
    expect(b.stdout).toBe("bbb");
  });

  it("should support mkdir -p and ls", async () => {
    const shell = new Shell();
    await shell.exec("mkdir -p /a/b/c");
    await shell.exec("touch /a/b/c/file.txt");
    const result = await shell.exec("find /a -type f");
    expect(result.stdout.trim()).toBe("/a/b/c/file.txt");
  });

  it("should support cp and mv", async () => {
    const shell = new Shell({
      files: { "/src.txt": "content" }
    });
    await shell.exec("cp /src.txt /copy.txt");
    const cp = await shell.exec("cat /copy.txt");
    expect(cp.stdout).toBe("content");

    await shell.exec("mv /copy.txt /moved.txt");
    const mv = await shell.exec("cat /moved.txt");
    expect(mv.stdout).toBe("content");

    const gone = await shell.exec("cat /copy.txt");
    expect(gone.exitCode).not.toBe(0);
  });

  it("should support symlinks", async () => {
    const shell = new Shell({
      files: { "/target.txt": "linked content" }
    });
    await shell.exec("ln -s /target.txt /link.txt");
    const result = await shell.exec("cat /link.txt");
    expect(result.stdout).toBe("linked content");
  });
});
