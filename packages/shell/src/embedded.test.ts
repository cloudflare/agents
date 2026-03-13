import { describe, expect, it } from "vitest";
import { EmbeddedExecutor } from "./embedded";
import type { QuickJSWASMModuleLike, PyodideLike } from "./embedded";
import { Bash } from "./Shell";

// ── Mock QuickJS ──────────────────────────────────────────────────
//
// A real QuickJS evalCode creates a WASM context, evaluates code,
// and returns the result. Our mock uses native eval to simulate it.

function createMockQuickJS(): QuickJSWASMModuleLike {
  return {
    evalCode(
      code: string,
      options?: {
        memoryLimitBytes?: number;
        shouldInterrupt?: () => boolean | undefined;
      }
    ): unknown {
      // Check interrupt before execution
      if (options?.shouldInterrupt?.()) {
        throw new Error("interrupted");
      }
      // eslint-disable-next-line no-eval
      return (0, eval)(code);
    }
  };
}

// ── Mock Pyodide ──────────────────────────────────────────────────
//
// Simulates Pyodide's runPython by parsing our wrapper script and
// executing the Python logic in JavaScript.

function createMockPyodide(): PyodideLike {
  return {
    runPython(code: string): unknown {
      // Extract the base64-encoded user code from the wrapper
      const b64Match = code.match(/__base64\.b64decode\(b'([^']+)'\)/);
      if (!b64Match) {
        throw new Error("Could not find base64-encoded code in wrapper");
      }
      const userCode = Buffer.from(b64Match[1], "base64").toString("utf-8");

      // Simulate Python execution of simple print() calls
      const stdout: string[] = [];
      const stderr: string[] = [];
      let exitCode = 0;

      try {
        // Very basic Python simulation for testing:
        // handle print(), raise, and sys.exit()
        const lines = userCode.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;

          const printMatch = trimmed.match(/^print\((['"])(.*?)\1\)$/);
          if (printMatch) {
            stdout.push(printMatch[2] + "\n");
            continue;
          }

          const printFStringMatch = trimmed.match(/^print\(f?(['"])(.*?)\1\)$/);
          if (printFStringMatch) {
            stdout.push(printFStringMatch[2] + "\n");
            continue;
          }

          if (trimmed.startsWith("raise ")) {
            const msg = trimmed.replace(/^raise\s+\w+\((['"])(.*?)\1\)/, "$2");
            stderr.push(
              `Traceback (most recent call last):\n  ${trimmed}\n${msg}\n`
            );
            exitCode = 1;
            break;
          }

          if (trimmed.match(/^import\s/)) {
            continue; // skip imports
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stderr.push(msg + "\n");
        exitCode = 1;
      }

      return JSON.stringify({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode
      });
    }
  };
}

// ── EmbeddedExecutor (QuickJS) ────────────────────────────────────

describe("EmbeddedExecutor (QuickJS)", () => {
  function createExecutor() {
    return new EmbeddedExecutor({ quickjs: createMockQuickJS() });
  }

  it("should execute JavaScript code", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'console.log("hello world")',
      "javascript"
    );
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should capture multiple console.log calls", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'console.log("a"); console.log("b"); console.log("c")',
      "javascript"
    );
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.exitCode).toBe(0);
  });

  it("should capture console.error as stderr", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'console.error("warning")',
      "javascript"
    );
    expect(result.stderr).toBe("warning\n");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should capture console.warn as stderr", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'console.warn("caution")',
      "javascript"
    );
    expect(result.stderr).toBe("caution\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle multiple arguments to console.log", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'console.log("a", "b", "c")',
      "javascript"
    );
    expect(result.stdout).toBe("a b c\n");
  });

  it("should handle runtime errors", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'throw new Error("boom")',
      "javascript"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("should handle syntax errors", async () => {
    const executor = createExecutor();
    const result = await executor.execute("function {invalid", "javascript");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
  });

  it("should provide process.env", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "console.log(process.env.MY_VAR)",
      "javascript",
      { env: { MY_VAR: "test_value" } }
    );
    expect(result.stdout).toBe("test_value\n");
  });

  it("should provide empty process.env by default", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "console.log(typeof process.env)",
      "javascript"
    );
    expect(result.stdout).toBe("object\n");
  });

  it("should handle code with special characters", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'console.log("line1\\nline2")',
      "javascript"
    );
    expect(result.stdout).toBe("line1\nline2\n");
  });

  it("should handle code with quotes", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "console.log('single') ; console.log(\"double\")",
      "javascript"
    );
    expect(result.stdout).toBe("single\ndouble\n");
  });

  it("should return error when quickjs not provided", async () => {
    const executor = new EmbeddedExecutor({});
    const result = await executor.execute("console.log(1)", "javascript");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("QuickJS engine not provided");
  });
});

// ── EmbeddedExecutor (Pyodide) ────────────────────────────────────

describe("EmbeddedExecutor (Pyodide)", () => {
  function createExecutor() {
    return new EmbeddedExecutor({ pyodide: createMockPyodide() });
  }

  it("should execute Python code", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'print("hello from python")',
      "python"
    );
    expect(result.stdout).toBe("hello from python\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle Python errors", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'raise ValueError("bad value")',
      "python"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bad value");
  });

  it("should return error when pyodide not provided", async () => {
    const executor = new EmbeddedExecutor({});
    const result = await executor.execute('print("hi")', "python");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Pyodide engine not provided");
  });
});

// ── EmbeddedExecutor (unsupported language) ───────────────────────

describe("EmbeddedExecutor (edge cases)", () => {
  it("should return error for unsupported language", async () => {
    const executor = new EmbeddedExecutor({ quickjs: createMockQuickJS() });
    const result = await executor.execute("code", "ruby" as "javascript");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported language");
  });

  it("should support both engines simultaneously", async () => {
    const executor = new EmbeddedExecutor({
      quickjs: createMockQuickJS(),
      pyodide: createMockPyodide()
    });

    const jsResult = await executor.execute('console.log("js")', "javascript");
    expect(jsResult.stdout).toBe("js\n");

    const pyResult = await executor.execute('print("py")', "python");
    expect(pyResult.stdout).toBe("py\n");
  });
});

// ── Shell integration (QuickJS) ───────────────────────────────────

describe("js-exec command (EmbeddedExecutor)", () => {
  function createShell() {
    const executor = new EmbeddedExecutor({ quickjs: createMockQuickJS() });
    return new Bash({ executor });
  }

  it("should execute inline JavaScript via js-exec", async () => {
    const shell = createShell();
    const result = await shell.exec('js-exec "console.log(42)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  });

  it("should execute JavaScript via pipe", async () => {
    const shell = createShell();
    const result = await shell.exec('echo "console.log(1+2+3)" | js-exec');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("6");
  });

  it("should handle js-exec errors gracefully", async () => {
    const shell = createShell();
    const result = await shell.exec("js-exec \"throw new Error('failed')\"");
    expect(result.exitCode).not.toBe(0);
  });

  it("node command should work as alias", async () => {
    const shell = createShell();
    const result = await shell.exec('node "console.log(99)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("99");
  });
});
