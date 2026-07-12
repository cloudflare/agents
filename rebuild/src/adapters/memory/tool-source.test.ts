import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../kernel/errors.js";
import { createMemoryToolSource } from "./tool-source.js";

describe("createMemoryToolSource", () => {
  it("exposes the given id", () => {
    const source = createMemoryToolSource("mcp-1", {});
    expect(source.id).toBe("mcp-1");
  });

  it("ready() resolves", async () => {
    const source = createMemoryToolSource("mcp-1", {});
    await expect(source.ready()).resolves.toBeUndefined();
  });

  it("listTools() returns descriptors for the static tool map", async () => {
    const source = createMemoryToolSource("mcp-1", {
      search: {
        descriptor: { name: "search", description: "search the web", inputSchema: {} },
        handler: async (input) => ({ results: [input] }),
      },
    });
    const tools = await source.listTools();
    expect(tools).toEqual([{ name: "search", description: "search the web", inputSchema: {} }]);
  });

  it("callTool() invokes the matching handler with input", async () => {
    const source = createMemoryToolSource("mcp-1", {
      echo: {
        descriptor: { name: "echo", description: "echoes input", inputSchema: {} },
        handler: async (input) => input,
      },
    });
    const result = await source.callTool("echo", { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("callTool() throws for an unknown tool name", async () => {
    const source = createMemoryToolSource("mcp-1", {});
    await expect(source.callTool("missing", {})).rejects.toThrow(NotFoundError);
  });

  it("callTool() propagates handler rejections", async () => {
    const source = createMemoryToolSource("mcp-1", {
      broken: {
        descriptor: { name: "broken", description: "always fails", inputSchema: {} },
        handler: async () => {
          throw new Error("kaboom");
        },
      },
    });
    await expect(source.callTool("broken", {})).rejects.toThrow("kaboom");
  });
});
