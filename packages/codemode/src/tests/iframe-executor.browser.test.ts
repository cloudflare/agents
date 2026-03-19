/**
 * Browser tests for IframeSandboxExecutor.
 *
 * These run in a real browser via @vitest/browser + Playwright.
 * No mocks — real iframes, real postMessage, real code execution.
 */
import { describe, expect, it } from "vitest";
import { IframeSandboxExecutor } from "../iframe-executor";

describe("IframeSandboxExecutor", () => {
  it("should execute simple code and return the result", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("async () => { return 42; }", {});
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should return undefined for void code", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("async () => {}", {});
    expect(result.result).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("should capture console.log, warn, and error output", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { console.log("hello", "world"); console.warn("warning!"); console.error("bad"); return 1; }',
      {}
    );
    expect(result.result).toBe(1);
    expect(result.logs).toContain("hello world");
    expect(result.logs).toContain("[warn] warning!");
    expect(result.logs).toContain("[error] bad");
  });

  it("should call tool functions via codemode proxy", async () => {
    const executor = new IframeSandboxExecutor();
    const fns = {
      getWeather: async (args: unknown) => {
        const { location } = args as { location: string };
        return `Sunny in ${location}`;
      }
    };
    const result = await executor.execute(
      'async () => { return await codemode.getWeather({ location: "London" }); }',
      fns
    );
    expect(result.result).toBe("Sunny in London");
    expect(result.error).toBeUndefined();
  });

  it("should handle multiple sequential tool calls", async () => {
    const executor = new IframeSandboxExecutor();
    const fns = {
      add: async (args: unknown) => {
        const { a, b } = args as { a: number; b: number };
        return a + b;
      }
    };
    const result = await executor.execute(
      "async () => { var x = await codemode.add({ a: 1, b: 2 }); var y = await codemode.add({ a: x, b: 10 }); return y; }",
      fns
    );
    expect(result.result).toBe(13);
  });

  it("should handle concurrent tool calls via Promise.all", async () => {
    const executor = new IframeSandboxExecutor();
    const fns = {
      identity: async (args: unknown) => args
    };
    const [r1, r2, r3] = await Promise.all([
      executor.execute(
        "async () => { return await codemode.identity({ v: 1 }); }",
        fns
      ),
      executor.execute(
        "async () => { return await codemode.identity({ v: 2 }); }",
        fns
      ),
      executor.execute(
        "async () => { return await codemode.identity({ v: 3 }); }",
        fns
      )
    ]);
    expect(r1.result).toEqual({ v: 1 });
    expect(r2.result).toEqual({ v: 2 });
    expect(r3.result).toEqual({ v: 3 });
  });

  it("should propagate tool call errors back to sandbox code", async () => {
    const executor = new IframeSandboxExecutor();
    const fns = {
      failTool: async () => {
        throw new Error("Tool failed");
      }
    };
    const result = await executor.execute(
      'async () => { try { await codemode.failTool(); return "should not reach"; } catch (e) { return "caught: " + e.message; } }',
      fns
    );
    expect(result.result).toBe("caught: Tool failed");
  });

  it("should return error for unknown tool", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { try { await codemode.nonexistent(); return "no"; } catch (e) { return "caught: " + e.message; } }',
      {}
    );
    expect(result.result).toBe('caught: Tool "nonexistent" not found');
  });

  it("should return error when code throws", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { throw new Error("boom"); }',
      {}
    );
    expect(result.error).toBe("boom");
    expect(result.result).toBeUndefined();
  });

  it("should enforce timeout for long-running code", async () => {
    const executor = new IframeSandboxExecutor({ timeout: 500 });
    const result = await executor.execute(
      "async () => { await new Promise(function() {}); }",
      {}
    );
    expect(result.error).toBe("Execution timed out");
  });

  it("should block network access via CSP", async () => {
    const executor = new IframeSandboxExecutor({ timeout: 3000 });
    const result = await executor.execute(
      'async () => { try { await fetch("https://example.com"); return "leaked"; } catch (e) { return "blocked: " + e.message; } }',
      {}
    );
    expect(result.result).not.toBe("leaked");
    expect(
      typeof result.result === "string" &&
        (result.result as string).startsWith("blocked:")
    ).toBe(true);
  });

  it("should handle template literals in code", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { return `hello ${"world"}`; }',
      {}
    );
    expect(result.result).toBe("hello world");
  });

  it("should apply sandbox=allow-scripts to the iframe", async () => {
    const executor = new IframeSandboxExecutor({ timeout: 50 });

    const execution = executor.execute(
      "async () => { await new Promise(function() {}); }",
      {}
    );
    const iframe = document.querySelector("iframe");

    expect(iframe?.sandbox.contains("allow-scripts")).toBe(true);
    expect(iframe?.style.display).toBe("none");
    expect(iframe?.srcdoc).toContain("Content-Security-Policy");

    await execution;
  });

  it("should clean up the iframe after execution", async () => {
    const beforeCount = document.querySelectorAll("iframe").length;
    const executor = new IframeSandboxExecutor();
    await executor.execute("async () => { return 1; }", {});
    const afterCount = document.querySelectorAll("iframe").length;
    expect(afterCount).toBe(beforeCount);
  });

  it("should preserve closures in tool functions", async () => {
    const secret = "api-key-123";
    const executor = new IframeSandboxExecutor();
    const fns = {
      getSecret: async () => ({ key: secret })
    };

    const result = await executor.execute(
      "async () => await codemode.getSecret({})",
      fns
    );
    expect(result.result).toEqual({ key: "api-key-123" });
  });
});

describe("createBrowserCodeTool", () => {
  it("should execute code end-to-end with real iframe sandbox", async () => {
    const { createBrowserCodeTool } = await import("../browser-tool");

    const tool = createBrowserCodeTool({
      tools: {
        addNumbers: {
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" }
            },
            required: ["a", "b"]
          },
          execute: async (args: Record<string, unknown>) => {
            const { a, b } = args as { a: number; b: number };
            return { sum: a + b };
          }
        }
      }
    });

    expect(tool.name).toBe("codemode");
    expect(tool.description).toContain("addNumbers");
    expect(tool.description).toContain("AddNumbersInput");
    expect(tool.description).toContain("declare const codemode");
    expect(tool.inputSchema.required).toEqual(["code"]);
    expect(tool.outputSchema.required).toEqual(["code", "result"]);

    const result = await tool.execute({
      code: "async () => await codemode.addNumbers({ a: 17, b: 25 })"
    });

    expect(result.result).toEqual({ sum: 42 });
    expect(result.code).toBe(
      "async () => await codemode.addNumbers({ a: 17, b: 25 })"
    );
  });

  it("should accept tools as an array", async () => {
    const { createBrowserCodeTool } = await import("../browser-tool");

    const tool = createBrowserCodeTool({
      tools: [
        {
          name: "greet",
          description: "Greet someone",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"]
          },
          execute: async (args: Record<string, unknown>) => {
            return "Hello, " + (args as { name: string }).name + "!";
          }
        }
      ]
    });

    const result = await tool.execute({
      code: 'async () => await codemode.greet({ name: "World" })'
    });

    expect(result.result).toBe("Hello, World!");
  });

  it("should throw on executor error", async () => {
    const { createBrowserCodeTool } = await import("../browser-tool");

    const tool = createBrowserCodeTool({
      tools: {
        noop: {
          description: "Does nothing",
          inputSchema: { type: "object" },
          execute: async () => null
        }
      }
    });

    await expect(
      tool.execute({ code: 'async () => { throw new Error("fail"); }' })
    ).rejects.toThrow("Code execution failed: fail");
  });
});
