/**
 * Workers Integration Tests — Core Shell
 *
 * Tests shell commands running inside the Cloudflare Workers runtime
 * via @cloudflare/vitest-pool-workers. Validates that the core shell,
 * pipes, redirects, and built-in commands all work with nodejs_compat.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub() {
  const id = env.TEST_SHELL_DO.newUniqueId();
  return env.TEST_SHELL_DO.get(id);
}

// ── Core commands in Workers runtime ────────────────────────────────

describe("Shell core commands (Workers runtime)", () => {
  it("should run echo", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand('echo "hello workers"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello workers\n");
  });

  it("should pipe sort", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand(
      'echo -e "cherry\\napple\\nbanana" | sort'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("apple\nbanana\ncherry\n");
  });

  it("should run grep", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand(
      'echo -e "INFO: ok\\nERROR: bad\\nINFO: done" | grep ERROR'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ERROR: bad\n");
  });

  it("should run jq", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand("echo '{\"a\":1,\"b\":2}' | jq '.b'");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("2");
  });

  it("should run awk", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand(
      "echo -e '10\\n20\\n30' | awk '{s+=$1} END {print s}'"
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("60");
  });

  it("should run sed", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand(
      "echo 'hello world' | sed 's/world/workers/'"
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello workers\n");
  });

  it("should handle file write and read via redirects", async () => {
    const stub = getStub();
    // Single exec since each call creates a new Shell (new filesystem)
    const r = await stub.execShellCommand(
      'echo "test content" > /tmp/test.txt && cat /tmp/test.txt'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("test content\n");
  });

  it("should handle base64 encode/decode", async () => {
    const stub = getStub();
    const enc = await stub.execShellCommand("echo -n 'workers' | base64");
    expect(enc.exitCode).toBe(0);
    const encoded = enc.stdout.trim();

    const dec = await stub.execShellCommand(`echo -n '${encoded}' | base64 -d`);
    expect(dec.exitCode).toBe(0);
    expect(dec.stdout).toBe("workers");
  });

  it("should handle for loop", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand('for i in 1 2 3; do echo "$i"; done');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  it("should handle command substitution", async () => {
    const stub = getStub();
    const r = await stub.execShellCommand(
      'echo "count: $(echo -e "a\\nb\\nc" | wc -l)"'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toContain("3");
  });
});

// ── Code executor in Workers runtime ────────────────────────────────

describe("DynamicIsolateExecutor (Workers runtime)", () => {
  it("should execute JavaScript", async () => {
    const stub = getStub();
    const r = await stub.executeCode("console.log(2 + 2)", "javascript");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("4");
  });

  it("should capture JavaScript errors", async () => {
    const stub = getStub();
    const r = await stub.executeCode(
      "throw new Error('test error')",
      "javascript"
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("test error");
  });

  it("should run js-exec via shell command", async () => {
    const stub = getStub();
    const r = await stub.execCodeShellCommand('js-exec "console.log(10 * 5)"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("50");
  });

  it("should pipe into js-exec command context", async () => {
    const stub = getStub();
    const r = await stub.execCodeShellCommand('echo "hello" | wc -c');
    expect(r.exitCode).toBe(0);
    // "hello\n" is 6 chars
    expect(r.stdout.trim()).toBe("6");
  });
});
