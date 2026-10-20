/**
 * Tests for the TanStack AI integration (`@cloudflare/codemode/tanstack-ai`).
 *
 * Covers createCodeTool, tanstackTools, and resolveProvider
 * using TanStack AI tool definitions.
 */
import { describe, it, expect, vi } from "vitest";
import { toolDefinition } from "@tanstack/ai";
import type { Tool as TanStackTool, ServerTool } from "@tanstack/ai";
import { z } from "zod";
import { createCodeTool, tanstackTools, resolveProvider } from "../tanstack-ai";
import type {
  Executor,
  ExecuteResult,
  ResolvedProvider,
  ToolProvider
} from "../executor";

/** A mock executor that records calls and returns configurable results. */
function createMockExecutor(result: ExecuteResult = { result: "ok" }) {
  const calls: {
    code: string;
    fnNames: string[];
    providers: ResolvedProvider[];
  }[] = [];
  const executor: Executor = {
    execute: vi.fn(
      async (
        code: string,
        providersOrFns:
          | ResolvedProvider[]
          | Record<string, (...args: unknown[]) => Promise<unknown>>
      ) => {
        const providers = Array.isArray(providersOrFns)
          ? providersOrFns
          : [{ name: "codemode", fns: providersOrFns }];
        const allFnNames = providers.flatMap((p) => Object.keys(p.fns));
        calls.push({ code, fnNames: allFnNames, providers });
        return result;
      }
    )
  };
  return { executor, calls };
}

// ── TanStack tool fixtures ───────────────────────────────────────────

const getWeatherDef = toolDefinition({
  name: "get_weather",
  description: "Get the current weather for a location",
  inputSchema: z.object({
    location: z.string().meta({ description: "City name, e.g. San Francisco" }),
    unit: z.enum(["celsius", "fahrenheit"]).optional()
  }),
  outputSchema: z.object({
    temperature: z.number(),
    conditions: z.string()
  })
});

const getWeatherServer = getWeatherDef.server(async ({ unit }) => ({
  temperature: unit === "celsius" ? 22 : 72,
  conditions: "sunny"
}));

const searchWebDef = toolDefinition({
  name: "search_web",
  description: "Search the web for information",
  inputSchema: z.object({
    query: z.string().meta({ description: "Search query" })
  })
});

const searchWebServer = searchWebDef.server(async ({ query }) => ({
  results: [`Result for: ${query}`]
}));

const dangerousDef = toolDefinition({
  name: "delete_all",
  description: "Delete everything",
  inputSchema: z.object({}),
  needsApproval: true
});

const dangerousServer = dangerousDef.server(async () => ({ deleted: true }));

// ── tanstackTools ────────────────────────────────────────────────────

describe("tanstackTools", () => {
  it("should create a ToolProvider from TanStack tools", () => {
    const provider = tanstackTools([getWeatherServer, searchWebServer]);

    expect(provider.tools).toBeDefined();
    expect(provider.types).toBeDefined();
  });

  it("should extract execute functions keyed by tool name", () => {
    const provider = tanstackTools([getWeatherServer, searchWebServer]);
    const tools = provider.tools as Record<string, { execute?: unknown }>;

    expect(tools.get_weather).toBeDefined();
    expect(tools.search_web).toBeDefined();
    expect(tools.get_weather.execute).toBeDefined();
    expect(tools.search_web.execute).toBeDefined();
  });

  it("should filter out tools with needsApproval", () => {
    const provider = tanstackTools([
      getWeatherServer,
      dangerousServer as unknown as TanStackTool
    ]);
    const tools = provider.tools as Record<string, unknown>;

    expect(tools.get_weather).toBeDefined();
    expect(tools.delete_all).toBeUndefined();
  });

  it("should use custom namespace name", () => {
    const provider = tanstackTools([getWeatherServer], "weather");

    expect(provider.name).toBe("weather");
  });

  it("should default to no name (defaults to codemode)", () => {
    const provider = tanstackTools([getWeatherServer]);

    expect(provider.name).toBeUndefined();
  });

  it("should pre-generate types string", () => {
    const provider = tanstackTools([getWeatherServer]);

    expect(provider.types).toContain("get_weather");
    expect(provider.types).toContain("GetWeatherInput");
  });

  it("should produce working execute functions", async () => {
    const provider = tanstackTools([getWeatherServer]);
    const tools = provider.tools as Record<
      string,
      { execute: (args: unknown) => Promise<unknown> }
    >;

    const result = await tools.get_weather.execute({
      location: "NYC",
      unit: "fahrenheit"
    });
    expect(result).toEqual({ temperature: 72, conditions: "sunny" });
  });

  it("should skip definition-only tools (no execute) from tool record but include in types", () => {
    const defOnly = toolDefinition({
      name: "client_action",
      description: "Runs on the client",
      inputSchema: z.object({ msg: z.string() })
    });

    const provider = tanstackTools([
      getWeatherServer,
      defOnly as unknown as TanStackTool
    ]);
    const tools = provider.tools as Record<string, unknown>;

    expect(tools.get_weather).toBeDefined();
    expect(tools.client_action).toBeUndefined();

    expect(provider.types).toContain("get_weather");
    expect(provider.types).toContain("client_action");
    expect(provider.types).toContain("ClientActionInput");
  });

  it("should handle empty tools array", () => {
    const provider = tanstackTools([]);

    expect(Object.keys(provider.tools)).toEqual([]);
  });
});

// ── createCodeTool ───────────────────────────────────────────────────

describe("createCodeTool", () => {
  it("should return a TanStack AI ServerTool", () => {
    const { executor } = createMockExecutor();
    const provider = tanstackTools([getWeatherServer, searchWebServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    expect(codeTool.name).toBe("codemode_execute");
    expect(codeTool.description).toBeDefined();
    expect(codeTool.execute).toBeDefined();
    expect((codeTool as ServerTool).__toolSide).toBe("server");
  });

  it("should include tool names in the description", () => {
    const { executor } = createMockExecutor();
    const provider = tanstackTools([getWeatherServer, searchWebServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    expect(codeTool.description).toContain("get_weather");
    expect(codeTool.description).toContain("search_web");
  });

  it("should include generated types in the description", () => {
    const { executor } = createMockExecutor();
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    expect(codeTool.description).toContain("GetWeatherInput");
    expect(codeTool.description).toContain("declare const codemode");
  });

  it("should support custom description with {{types}} placeholder", () => {
    const { executor } = createMockExecutor();
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({
      tools: [provider],
      executor,
      description: "Custom prefix.\n\n{{types}}\n\nCustom suffix."
    });

    expect(codeTool.description).toContain("Custom prefix.");
    expect(codeTool.description).toContain("Custom suffix.");
    expect(codeTool.description).toContain("get_weather");
  });

  it("should pass code to executor and return result on success", async () => {
    const { executor, calls } = createMockExecutor({ result: { answer: 42 } });
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    const output = await codeTool.execute!(
      { code: "async () => 42" },
      undefined
    );

    expect(calls).toHaveLength(1);
    expect(output).toEqual({
      result: { answer: 42 }
    });
  });

  it("should pass extracted fns to executor", async () => {
    const { executor, calls } = createMockExecutor();
    const provider = tanstackTools([getWeatherServer, searchWebServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    await codeTool.execute!(
      { code: "async () => codemode.get_weather({ location: 'NYC' })" },
      undefined
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].fnNames).toContain("get_weather");
    expect(calls[0].fnNames).toContain("search_web");
  });

  it("should throw when executor returns error", async () => {
    const { executor } = createMockExecutor({
      result: undefined,
      error: "execution failed"
    });
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    await expect(
      codeTool.execute!({ code: "async () => null" }, undefined)
    ).rejects.toThrow("Code execution failed: execution failed");
  });

  it("should include console output in error message when logs present", async () => {
    const { executor } = createMockExecutor({
      result: undefined,
      error: "runtime error",
      logs: ["debug info", "[error] something went wrong"]
    });
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    await expect(
      codeTool.execute!({ code: "async () => null" }, undefined)
    ).rejects.toThrow("Console output:");
  });

  it("should include logs in successful output", async () => {
    const { executor } = createMockExecutor({
      result: "ok",
      logs: ["log line 1", "log line 2"]
    });
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    const output = await codeTool.execute!(
      { code: "async () => 'ok'" },
      undefined
    );

    expect((output as unknown as Record<string, unknown>)?.logs).toEqual([
      "log line 1",
      "log line 2"
    ]);
  });

  it("should support multiple namespaces", async () => {
    const { executor, calls } = createMockExecutor();
    const weatherProvider = tanstackTools([getWeatherServer], "weather");
    const searchProvider = tanstackTools([searchWebServer], "search");
    const codeTool = createCodeTool({
      tools: [weatherProvider, searchProvider],
      executor
    });

    expect(codeTool.description).toContain("declare const weather");
    expect(codeTool.description).toContain("declare const search");

    await codeTool.execute!(
      {
        code: "async () => weather.get_weather({ location: 'NYC' })"
      },
      undefined
    );

    expect(calls[0].providers).toHaveLength(2);
    expect(calls[0].providers[0].name).toBe("weather");
    expect(calls[0].providers[1].name).toBe("search");
  });

  it("should exclude needsApproval tools from description and execution", async () => {
    const { executor, calls } = createMockExecutor();
    const provider = tanstackTools([
      getWeatherServer,
      dangerousServer as unknown as TanStackTool
    ]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    expect(codeTool.description).toContain("get_weather");
    expect(codeTool.description).not.toContain("delete_all");

    await codeTool.execute!({ code: "async () => null" }, undefined);

    expect(calls[0].fnNames).toContain("get_weather");
    expect(calls[0].fnNames).not.toContain("delete_all");
  });

  it("should normalize code before passing to executor", async () => {
    const { executor, calls } = createMockExecutor();
    const provider = tanstackTools([getWeatherServer]);
    const codeTool = createCodeTool({ tools: [provider], executor });

    await codeTool.execute!({ code: "async () => { return 42; }" }, undefined);

    expect(calls[0].code).toBe("async () => { return 42; }");
  });

  it("should fall back to generateTypesFromRecord when provider has no types string", async () => {
    const { executor, calls } = createMockExecutor();

    const provider: ToolProvider = {
      name: "raw",
      tools: {
        doStuff: {
          description: "Does stuff",
          execute: async () => "done"
        },
        noDesc: {
          execute: async () => 42
        }
      }
    };

    const codeTool = createCodeTool({ tools: [provider], executor });

    expect(codeTool.description).toContain("declare const raw");
    expect(codeTool.description).toContain("doStuff");
    expect(codeTool.description).toContain("Does stuff");
    expect(codeTool.description).toContain("type DoStuffInput = unknown");
    expect(codeTool.description).toContain("type DoStuffOutput = unknown");
    expect(codeTool.description).toContain("noDesc");

    await codeTool.execute!({ code: "async () => raw.doStuff()" }, undefined);

    expect(calls[0].fnNames).toContain("doStuff");
    expect(calls[0].fnNames).toContain("noDesc");
  });

  it("should accept raw ToolProviderTools (not wrapped in provider array)", async () => {
    const { executor, calls } = createMockExecutor();

    const codeTool = createCodeTool({
      tools: {
        myFn: {
          description: "A function",
          execute: async () => "result"
        }
      },
      executor
    });

    expect(codeTool.description).toContain("myFn");
    expect(codeTool.description).toContain("declare const codemode");

    await codeTool.execute!({ code: "async () => codemode.myFn()" }, undefined);

    expect(calls[0].fnNames).toContain("myFn");
    expect(calls[0].providers[0].name).toBe("codemode");
  });

  it("should resolve named providers without dispatch flags", async () => {
    const { executor, calls } = createMockExecutor();

    const provider: ToolProvider = {
      name: "state",
      tools: {
        writeFile: {
          description: "Write a file",
          execute: async () => ({ ok: true })
        }
      }
    };

    const codeTool = createCodeTool({ tools: [provider], executor });

    await codeTool.execute!({ code: "async () => null" }, undefined);

    expect(calls[0].providers[0].name).toBe("state");
    expect(calls[0].providers[0].fns.writeFile).toEqual(expect.any(Function));
  });

  it("should work with plain ToolProvider (non-tanstack)", async () => {
    const { executor, calls } = createMockExecutor();

    const provider: ToolProvider = {
      name: "custom",
      tools: {
        ping: {
          description: "Ping",
          execute: async () => "pong"
        }
      },
      types: "declare const custom: { ping: () => Promise<string>; }"
    };

    const codeTool = createCodeTool({ tools: [provider], executor });

    expect(codeTool.description).toContain("declare const custom");

    await codeTool.execute!({ code: "async () => custom.ping()" }, undefined);

    expect(calls[0].fnNames).toContain("ping");
  });
});

// ── resolveProvider (re-export from resolve.ts) ──────────────────────

describe("resolveProvider (re-export)", () => {
  it("should resolve a ToolProvider with default namespace", () => {
    const provider: ToolProvider = {
      tools: {
        tool: {
          description: "Tool",
          execute: async () => ({})
        }
      }
    };

    const resolved = resolveProvider(provider);
    expect(resolved.name).toBe("codemode");
    expect(resolved.fns.tool).toBeDefined();
  });

  it("should resolve from tanstackTools output", async () => {
    const provider = tanstackTools([getWeatherServer], "weather");
    const resolved = resolveProvider(provider);

    expect(resolved.name).toBe("weather");
    expect(resolved.fns.get_weather).toBeDefined();

    const result = await resolved.fns.get_weather({
      location: "LA",
      unit: "celsius"
    });
    expect(result).toEqual({ temperature: 22, conditions: "sunny" });
  });
});

describe("tanstackTools needsApproval", () => {
  it("keeps tools with needsApproval: false and filters tools with needsApproval: true", () => {
    const provider = tanstackTools([
      {
        name: "explicitly_safe",
        description: "Explicitly safe",
        needsApproval: false,
        execute: async () => ({ ok: true })
      } as unknown as TanStackTool
    ]);

    expect(provider.types).toContain("explicitly_safe");
    expect(provider.tools).toHaveProperty("explicitly_safe");

    const filtered = tanstackTools([
      dangerousServer as unknown as TanStackTool
    ]);
    expect(filtered.tools).not.toHaveProperty("delete_all");
  });
});
