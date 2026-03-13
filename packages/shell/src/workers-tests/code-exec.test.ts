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

// ── DynamicIsolateExecutor (via DO with real CodeWorkerLike) ────────

describe("DynamicIsolateExecutor (real Workers runtime)", () => {
  it("should execute JavaScript code", async () => {
    const stub = getStub();
    const result = await stub.executeCode(
      'console.log("hello world")',
      "javascript"
    );
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle multiple console.log calls", async () => {
    const stub = getStub();
    const result = await stub.executeCode(
      'console.log("a"); console.log("b"); console.log("c")',
      "javascript"
    );
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.exitCode).toBe(0);
  });

  it("should capture stderr from console.error", async () => {
    const stub = getStub();
    const result = await stub.executeCode(
      'console.error("something wrong")',
      "javascript"
    );
    expect(result.stderr).toContain("something wrong");
    expect(result.exitCode).toBe(0);
  });

  it("should handle syntax errors", async () => {
    const stub = getStub();
    const result = await stub.executeCode("function {invalid", "javascript");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
  });

  it("should handle runtime errors", async () => {
    const stub = getStub();
    const result = await stub.executeCode(
      'throw new Error("boom")',
      "javascript"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("should handle arithmetic", async () => {
    const stub = getStub();
    const result = await stub.executeCode(
      "console.log(2 + 3 * 4)",
      "javascript"
    );
    expect(result.stdout.trim()).toBe("14");
  });

  it("should handle python execution failure gracefully", async () => {
    const stub = getStub();
    const result = await stub.executeCode('print("hello")', "python");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });
});

// ── js-exec command (real Workers runtime) ─────────────────────────

describe("js-exec command (real Workers runtime)", () => {
  it("should execute inline JavaScript", async () => {
    const stub = getStub();
    const result = await stub.execCodeShellCommand('js-exec "console.log(42)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  });

  it("should execute JavaScript via pipe", async () => {
    const stub = getStub();
    const result = await stub.execCodeShellCommand(
      'echo "console.log(1+2+3)" | js-exec'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("6");
  });

  it("should handle errors from JavaScript execution", async () => {
    const stub = getStub();
    const result = await stub.execCodeShellCommand(
      "js-exec \"throw new Error('failed')\""
    );
    expect(result.exitCode).toBe(1);
  });

  it("node command should work as alias", async () => {
    const stub = getStub();
    const result = await stub.execCodeShellCommand('node "console.log(99)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("99");
  });
});

// ── python3 command (unsupported language in test runner) ───────────

describe("python3 command (real Workers runtime)", () => {
  it("should report unsupported language from code runner", async () => {
    const stub = getStub();
    const result = await stub.execCodeShellCommand('python3 -c "print(1)"');
    // Our test CodeRunner doesn't support Python
    expect(result.exitCode).not.toBe(0);
  });
});
