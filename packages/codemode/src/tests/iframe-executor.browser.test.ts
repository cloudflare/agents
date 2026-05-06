/**
 * Browser tests for IframeSandboxExecutor.
 *
 * These run in a real browser via @vitest/browser + Playwright.
 * No mocks — real iframes, real postMessage, real code execution.
 */
import { describe, expect, it } from "vitest";
import { IframeSandboxExecutor } from "../iframe-executor";
import type { ResolvedProvider } from "../executor-types";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

function codemodeProvider(fns: ToolFns): ResolvedProvider {
  return { name: "codemode", fns };
}

describe("IframeSandboxExecutor", () => {
  it("should execute simple code and return the result", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("async () => { return 42; }", [
      codemodeProvider({})
    ]);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should return undefined for void code", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("async () => {}", [
      codemodeProvider({})
    ]);
    expect(result.result).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("should normalize bare expressions into async arrow functions", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("42", [codemodeProvider({})]);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should strip fenced code before execution", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("```js\n1 + 1\n```", [
      codemodeProvider({})
    ]);
    expect(result.result).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("should capture console.log, warn, and error output", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { console.log("hello", "world"); console.warn("warning!"); console.error("bad"); return 1; }',
      [codemodeProvider({})]
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
      [codemodeProvider(fns)]
    );
    expect(result.result).toBe("Sunny in London");
    expect(result.error).toBeUndefined();
  });

  it("should sanitize tool names with hyphens and dots", async () => {
    const executor = new IframeSandboxExecutor();
    const fns = {
      "github.list-issues": async () => [{ id: 1, title: "bug" }]
    };
    const result = await executor.execute(
      "async () => await codemode.github_list_issues({})",
      [codemodeProvider(fns)]
    );
    expect(result.result).toEqual([{ id: 1, title: "bug" }]);
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
      [codemodeProvider(fns)]
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
        [codemodeProvider(fns)]
      ),
      executor.execute(
        "async () => { return await codemode.identity({ v: 2 }); }",
        [codemodeProvider(fns)]
      ),
      executor.execute(
        "async () => { return await codemode.identity({ v: 3 }); }",
        [codemodeProvider(fns)]
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
      [codemodeProvider(fns)]
    );
    expect(result.result).toBe("caught: Tool failed");
  });

  it("should return error for unknown tool", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { try { await codemode.nonexistent(); return "no"; } catch (e) { return "caught: " + e.message; } }',
      [codemodeProvider({})]
    );
    expect(result.result).toBe('caught: Tool "nonexistent" not found');
  });

  it("should return error when code throws", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute(
      'async () => { throw new Error("boom"); }',
      [codemodeProvider({})]
    );
    expect(result.error).toBe("boom");
    expect(result.result).toBeUndefined();
  });

  it("should enforce timeout for long-running code", async () => {
    const executor = new IframeSandboxExecutor({ timeout: 500 });
    const result = await executor.execute(
      "async () => { await new Promise(function() {}); }",
      [codemodeProvider({})]
    );
    expect(result.error).toBe("Execution timed out");
  });

  it("should block network access via CSP", async () => {
    const executor = new IframeSandboxExecutor({ timeout: 3000 });
    const result = await executor.execute(
      'async () => { try { await fetch("https://example.com"); return "leaked"; } catch (e) { return "blocked: " + e.message; } }',
      [codemodeProvider({})]
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
      [codemodeProvider({})]
    );
    expect(result.result).toBe("hello world");
  });

  it("should apply sandbox=allow-scripts to the iframe", async () => {
    const executor = new IframeSandboxExecutor({ timeout: 50 });

    const execution = executor.execute(
      "async () => { await new Promise(function() {}); }",
      [codemodeProvider({})]
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
    await executor.execute("async () => { return 1; }", [codemodeProvider({})]);
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
      [codemodeProvider(fns)]
    );
    expect(result.result).toEqual({ key: "api-key-123" });
  });

  it("should work with empty providers array", async () => {
    const executor = new IframeSandboxExecutor();
    const result = await executor.execute("async () => 42", []);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });
});

describe("IframeSandboxExecutor namespaces", () => {
  it("exposes tools under a named provider namespace", async () => {
    const echo = async (args: unknown) => {
      const { msg } = args as { msg: string };
      return { echoed: msg };
    };
    const executor = new IframeSandboxExecutor();

    const result = await executor.execute(
      'async () => await myns.echo({ msg: "hello" })',
      [{ name: "myns", fns: { echo } }]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ echoed: "hello" });
  });

  it("named provider and codemode.* coexist in the same sandbox", async () => {
    const add = async (args: unknown) => {
      const { a, b } = args as { a: number; b: number };
      return a + b;
    };
    const ping = async (args: unknown) => {
      const { msg } = args as { msg: number };
      return { echoed: msg };
    };
    const executor = new IframeSandboxExecutor();

    const result = await executor.execute(
      `async () => {
        const sum = await codemode.add({ a: 3, b: 4 });
        const pong = await echo.ping({ msg: sum });
        return { sum, pong };
      }`,
      [codemodeProvider({ add }), { name: "echo", fns: { ping } }]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      sum: 7,
      pong: { echoed: 7 }
    });
  });

  it("supports positional argument providers", async () => {
    const join = async (...args: unknown[]) => args.join("/");
    const executor = new IframeSandboxExecutor();

    const result = await executor.execute(
      'async () => await state.join("a", "b", "c")',
      [{ name: "state", fns: { join }, positionalArgs: true }]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("a/b/c");
  });

  it("rejects duplicate provider names", async () => {
    const executor = new IframeSandboxExecutor();

    const result = await executor.execute("async () => 1", [
      { name: "dup", fns: {} },
      { name: "dup", fns: {} }
    ]);

    expect(result.error).toContain("Duplicate");
  });

  it("rejects reserved provider names", async () => {
    const executor = new IframeSandboxExecutor();

    const result = await executor.execute("async () => 1", [
      { name: "__dispatchers", fns: {} }
    ]);

    expect(result.error).toContain("reserved");
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

  it("should exclude approval-gated tools from object-form descriptions and execution", async () => {
    const { createBrowserCodeTool } = await import("../browser-tool");

    const tool = createBrowserCodeTool({
      tools: {
        safeTool: {
          description: "Safe tool",
          inputSchema: { type: "object" },
          execute: async () => ({ ok: true })
        },
        dangerousTool: {
          description: "Dangerous tool",
          inputSchema: { type: "object" },
          needsApproval: true,
          execute: async () => ({ deleted: true })
        }
      }
    });

    expect(tool.description).toContain("safeTool");
    expect(tool.description).not.toContain("dangerousTool");
    expect(tool.description).toContain("SafeToolInput");
    expect(tool.description).not.toContain("DangerousToolInput");

    const safeResult = await tool.execute({
      code: "async () => await codemode.safeTool({})"
    });
    expect(safeResult.result).toEqual({ ok: true });

    await expect(
      tool.execute({ code: "async () => await codemode.dangerousTool({})" })
    ).rejects.toThrow('Code execution failed: Tool "dangerousTool" not found');
  });

  it("should exclude approval-gated tools from array-form descriptions and execution", async () => {
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
        },
        {
          name: "deleteAll",
          description: "Delete everything",
          inputSchema: { type: "object" },
          needsApproval: async () => true,
          execute: async () => ({ deleted: true })
        }
      ]
    });

    expect(tool.description).toContain("greet");
    expect(tool.description).not.toContain("deleteAll");
    expect(tool.description).toContain("GreetInput");
    expect(tool.description).not.toContain("DeleteAllInput");

    const safeResult = await tool.execute({
      code: 'async () => await codemode.greet({ name: "World" })'
    });
    expect(safeResult.result).toBe("Hello, World!");

    await expect(
      tool.execute({ code: "async () => await codemode.deleteAll({})" })
    ).rejects.toThrow('Code execution failed: Tool "deleteAll" not found');
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
