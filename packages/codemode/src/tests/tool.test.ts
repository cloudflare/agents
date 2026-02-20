/**
 * Tests for createCodeTool — the function that wires tools + executor into
 * a single AI SDK tool.
 */
import { describe, it, expect, vi } from "vitest";
import { createCodeTool } from "../tool";
import { z } from "zod";
import type { ToolDescriptors } from "../types";
import type { Executor, ExecuteResult } from "../executor";

/** A mock executor that records calls and returns configurable results. */
function createMockExecutor(result: ExecuteResult = { result: "ok" }) {
  const calls: { code: string; fnNames: string[] }[] = [];
  const executor: Executor = {
    execute: vi.fn(async (code, fns) => {
      calls.push({ code, fnNames: Object.keys(fns) });
      return result;
    })
  };
  return { executor, calls };
}

describe("createCodeTool", () => {
  const tools: ToolDescriptors = {
    getWeather: {
      description: "Get weather for a location",
      inputSchema: z.object({ location: z.string() }),
      execute: async (_args: unknown) => ({ temp: 72 })
    },
    searchWeb: {
      description: "Search the web",
      inputSchema: z.object({ query: z.string() }),
      execute: async (_args: unknown) => ({ results: [] })
    }
  };

  it("should return a tool with correct structure", () => {
    const { executor } = createMockExecutor();
    const codeTool = createCodeTool({ tools, executor });

    expect(codeTool).toBeDefined();
    expect(codeTool.description).toBeDefined();
    expect(codeTool.execute).toBeDefined();
  });

  it("should include tool names in the description", () => {
    const { executor } = createMockExecutor();
    const codeTool = createCodeTool({ tools, executor });

    expect(codeTool.description).toContain("getWeather");
    expect(codeTool.description).toContain("searchWeb");
  });

  it("should include generated types in the description", () => {
    const { executor } = createMockExecutor();
    const codeTool = createCodeTool({ tools, executor });

    // Should contain the generated TypeScript type names
    expect(codeTool.description).toContain("GetWeatherInput");
    expect(codeTool.description).toContain("SearchWebInput");
    expect(codeTool.description).toContain("declare const codemode");
  });

  it("should support custom description with {{types}} placeholder", () => {
    const { executor } = createMockExecutor();
    const codeTool = createCodeTool({
      tools,
      executor,
      description: "Custom prefix.\n\n{{types}}\n\nCustom suffix."
    });

    expect(codeTool.description).toContain("Custom prefix.");
    expect(codeTool.description).toContain("Custom suffix.");
    expect(codeTool.description).toContain("getWeather");
  });

  it("should pass code and extracted fns to executor", async () => {
    const { executor, calls } = createMockExecutor();
    const codeTool = createCodeTool({ tools, executor });

    await codeTool.execute?.(
      { code: "async () => codemode.getWeather({ location: 'NYC' })" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe(
      "async () => codemode.getWeather({ location: 'NYC' })"
    );
    expect(calls[0].fnNames).toContain("getWeather");
    expect(calls[0].fnNames).toContain("searchWeb");
  });

  it("should extract working execute functions from tools", async () => {
    const executeSpy = vi.fn(async (_args: unknown) => ({ temp: 99 }));
    const testTools: ToolDescriptors = {
      myTool: {
        description: "Test",
        inputSchema: z.object({ x: z.number() }),
        execute: executeSpy
      }
    };

    let capturedFns: Record<string, Function> = {};
    const executor: Executor = {
      execute: vi.fn(async (code, fns) => {
        capturedFns = fns;
        // Actually call the fn to verify it works
        const result = await fns.myTool({ x: 42 });
        return { result };
      })
    };

    const codeTool = createCodeTool({ tools: testTools, executor });
    await codeTool.execute?.(
      { code: "async () => null" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect(executeSpy).toHaveBeenCalledWith({ x: 42 });
    expect(capturedFns.myTool).toBeDefined();
  });

  it("should skip tools without execute functions", async () => {
    const testTools: ToolDescriptors = {
      withExecute: {
        description: "Has execute",
        inputSchema: z.object({}),
        execute: async () => ({})
      },
      withoutExecute: {
        description: "No execute",
        inputSchema: z.object({})
      }
    };

    let capturedFnNames: string[] = [];
    const executor: Executor = {
      execute: vi.fn(async (_code, fns) => {
        capturedFnNames = Object.keys(fns);
        return { result: null };
      })
    };

    const codeTool = createCodeTool({ tools: testTools, executor });
    await codeTool.execute?.(
      { code: "async () => null" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect(capturedFnNames).toContain("withExecute");
    expect(capturedFnNames).not.toContain("withoutExecute");
  });

  it("should exclude tools with needsApproval: true from fns and description", async () => {
    const testTools = {
      safeTool: {
        description: "Safe tool",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true })
      },
      dangerousTool: {
        description: "Dangerous tool",
        inputSchema: z.object({}),
        execute: async () => ({ deleted: true }),
        needsApproval: true
      }
    };

    let capturedFnNames: string[] = [];
    const executor: Executor = {
      execute: vi.fn(async (_code, fns) => {
        capturedFnNames = Object.keys(fns);
        return { result: null };
      })
    };

    const codeTool = createCodeTool({ tools: testTools, executor });

    expect(codeTool.description).toContain("safeTool");
    expect(codeTool.description).not.toContain("dangerousTool");

    await codeTool.execute?.(
      { code: "async () => null" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect(capturedFnNames).toContain("safeTool");
    expect(capturedFnNames).not.toContain("dangerousTool");
  });

  it("should exclude tools with needsApproval as a function", async () => {
    const testTools = {
      normalTool: {
        description: "Normal",
        inputSchema: z.object({}),
        execute: async () => ({})
      },
      approvalFnTool: {
        description: "Approval fn",
        inputSchema: z.object({}),
        execute: async () => ({}),
        needsApproval: async () => true
      }
    };

    let capturedFnNames: string[] = [];
    const executor: Executor = {
      execute: vi.fn(async (_code, fns) => {
        capturedFnNames = Object.keys(fns);
        return { result: null };
      })
    };

    const codeTool = createCodeTool({ tools: testTools, executor });

    expect(codeTool.description).not.toContain("approvalFnTool");

    await codeTool.execute?.(
      { code: "async () => null" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect(capturedFnNames).toContain("normalTool");
    expect(capturedFnNames).not.toContain("approvalFnTool");
  });

  it("should return { code, result } on success", async () => {
    const { executor } = createMockExecutor({ result: { answer: 42 } });
    const codeTool = createCodeTool({ tools, executor });

    const output = await codeTool.execute?.(
      { code: "async () => 42" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect(output).toEqual({
      code: "async () => 42",
      result: { answer: 42 }
    });
  });

  it("should throw when executor returns error", async () => {
    const { executor } = createMockExecutor({
      result: undefined,
      error: "execution failed"
    });
    const codeTool = createCodeTool({ tools, executor });

    await expect(
      codeTool.execute?.(
        { code: "async () => null" },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      )
    ).rejects.toThrow("Code execution failed: execution failed");
  });

  it("should include console output in error message when logs present", async () => {
    const { executor } = createMockExecutor({
      result: undefined,
      error: "runtime error",
      logs: ["debug info", "[error] something went wrong"]
    });
    const codeTool = createCodeTool({ tools, executor });

    await expect(
      codeTool.execute?.(
        { code: "async () => null" },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      )
    ).rejects.toThrow("Console output:");
  });

  it("should include logs in successful output", async () => {
    const { executor } = createMockExecutor({
      result: "ok",
      logs: ["log line 1", "log line 2"]
    });
    const codeTool = createCodeTool({ tools, executor });

    const output = await codeTool.execute?.(
      { code: "async () => 'ok'" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect((output as unknown as Record<string, unknown>)?.logs).toEqual([
      "log line 1",
      "log line 2"
    ]);
  });

  describe("code normalization", () => {
    it("should pass arrow functions through unchanged", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      await codeTool.execute?.(
        { code: "async () => { return 42; }" },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      expect(calls[0].code).toBe("async () => { return 42; }");
    });

    it("should splice return into last expression in named-function-then-call pattern", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = `const fn = async () => { return 42; };\nfn().catch(console.error);`;
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      // AST normalization wraps the last expression in return(...)
      expect(calls[0].code).toContain("async () => {");
      expect(calls[0].code).toContain("return (fn().catch(console.error))");
    });

    it("should not prepend return to declarations on last line", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = `const x = 1;\nconst y = 2;`;
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      expect(calls[0].code).toContain("async () => {");
      expect(calls[0].code).not.toContain("return const");
    });

    it("should not prepend return to control flow on last line", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = `const items = [];\nif (items.length === 0) { return null; }`;
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      expect(calls[0].code).toContain("async () => {");
      expect(calls[0].code).not.toContain("return if");
    });

    it("should not prepend return when last line already has return", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = `const r = await codemode.getWeather({ location: "NYC" });\nreturn r;`;
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      expect(calls[0].code).toContain("async () => {");
      expect(calls[0].code).toContain("return r;");
      expect(calls[0].code).not.toContain("return return");
    });

    it("should pass parenthesized arrow functions through unchanged", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = `(async () => { return 42; })`;
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      // Parenthesized arrow is still an ArrowFunctionExpression in the AST
      expect(calls[0].code).toBe("(async () => { return 42; })");
    });

    it("should handle template literals with backticks in code", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = 'async () => { return `hello ${"world"}`; }';
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      expect(calls[0].code).toBe(code);
    });

    it("should wrap syntax errors as fallback", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      const code = `this is not valid javascript @#$`;
      await codeTool.execute?.(
        { code },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      // Falls back to wrapping in async arrow
      expect(calls[0].code).toContain("async () => {");
      expect(calls[0].code).toContain(code);
    });

    it("should return empty async arrow for empty/whitespace input", async () => {
      const { executor, calls } = createMockExecutor();
      const codeTool = createCodeTool({ tools, executor });

      await codeTool.execute?.(
        { code: "   " },
        {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
      );

      expect(calls[0].code).toBe("async () => {}");
    });
  });

  it("should preserve closure state across multiple calls", async () => {
    let counter = 0;
    const testTools: ToolDescriptors = {
      increment: {
        description: "Increment counter",
        inputSchema: z.object({}),
        execute: async () => ({ count: ++counter })
      }
    };

    const executor: Executor = {
      execute: vi.fn(async (_code, fns) => {
        const result = await fns.increment({});
        return { result };
      })
    };

    const codeTool = createCodeTool({ tools: testTools, executor });

    const r1 = await codeTool.execute?.(
      { code: "call1" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );
    const r2 = await codeTool.execute?.(
      { code: "call2" },
      {} as unknown as Parameters<NonNullable<typeof codeTool.execute>>[1]
    );

    expect((r1 as unknown as Record<string, unknown>)?.result).toEqual({
      count: 1
    });
    expect((r2 as unknown as Record<string, unknown>)?.result).toEqual({
      count: 2
    });
    expect(counter).toBe(2);
  });
});
