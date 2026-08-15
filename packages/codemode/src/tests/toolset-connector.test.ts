import { jsonSchema, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolSetConnector, toolSetConnector } from "../connectors/toolset";

const ctx = {} as ExecutionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolSetConnector", () => {
  it("defaults to the 'tools' namespace and honors a custom name", () => {
    expect(toolSetConnector(ctx, { tools: {} }).name()).toBe("tools");
    expect(toolSetConnector(ctx, { tools: {}, name: "crm" }).name()).toBe(
      "crm"
    );
  });

  it("adapts executable tools, mapping needsApproval to requiresApproval", async () => {
    const connector = new ToolSetConnector(ctx, {
      tools: {
        getWeather: tool({
          description: "Get the weather",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => `sunny in ${city}`
        }),
        sendEmail: tool({
          description: "Send an email",
          inputSchema: z.object({ to: z.string() }),
          needsApproval: true,
          execute: async () => "sent"
        }),
        deleteUser: tool({
          description: "Delete a user",
          inputSchema: z.object({ id: z.string() }),
          // A function can't be pre-evaluated against sandbox args — it must
          // conservatively always require approval.
          needsApproval: async () => false,
          execute: async () => "deleted"
        })
      }
    });

    const desc = await connector.describe();
    expect(Object.keys(desc.descriptors).sort()).toEqual([
      "deleteUser",
      "getWeather",
      "sendEmail"
    ]);
    expect(desc.annotations?.getWeather).toBeUndefined();
    expect(desc.annotations?.sendEmail).toEqual({ requiresApproval: true });
    expect(desc.annotations?.deleteUser).toEqual({ requiresApproval: true });

    await expect(
      connector.executeTool("getWeather", { city: "Lisbon" })
    ).resolves.toBe("sunny in Lisbon");
  });

  it("validates args against the tool schema before executing", async () => {
    const execute = vi.fn(async () => "ok");
    const connector = new ToolSetConnector(ctx, {
      tools: {
        strict: tool({
          inputSchema: z.object({ n: z.number() }),
          execute
        })
      }
    });

    await expect(
      connector.executeTool("strict", { n: "not a number" })
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();

    await expect(connector.executeTool("strict", { n: 1 })).resolves.toBe("ok");
  });

  it("passes stable AI SDK call options and drains streamed terminal output", async () => {
    const execute = vi.fn(async function* (
      _input: { command: string },
      options
    ) {
      yield { status: "running", callId: options.toolCallId };
      yield { status: "completed", callId: options.toolCallId };
    });
    const connector = new ToolSetConnector(ctx, {
      tools: {
        exec: tool({
          inputSchema: z.object({ command: z.string() }),
          execute
        })
      }
    });

    await expect(
      connector.executeTool(
        "exec",
        { command: "test" },
        { executionId: "exec_1", seq: 4, callId: "exec_1:4" }
      )
    ).resolves.toEqual({ status: "completed", callId: "exec_1:4" });
    expect(execute).toHaveBeenCalledWith(
      { command: "test" },
      expect.objectContaining({ toolCallId: "exec_1:4", messages: [] })
    );
  });

  it("assigns distinct fallback call ids to direct and legacy calls", async () => {
    const ids: string[] = [];
    const connector = new ToolSetConnector(ctx, {
      tools: {
        inspect: tool({
          inputSchema: z.object({}),
          execute: async (_input, options) => {
            ids.push(options.toolCallId);
            return options.toolCallId;
          }
        })
      }
    });

    await connector.executeTool("inspect", {});
    await connector.executeTool("inspect", {});
    await connector.executeTool("inspect", {}, { executionId: "legacy" });
    await connector.executeTool("inspect", {}, { executionId: "legacy" });

    expect(new Set(ids).size).toBe(4);
    expect(
      ids.slice(0, 2).every((id) => id.startsWith("codemode:direct:"))
    ).toBe(true);
    expect(ids.slice(2).every((id) => id.startsWith("legacy:"))).toBe(true);
  });

  it("preserves output schemas in connector descriptions", async () => {
    const connector = new ToolSetConnector(ctx, {
      name: "workspace",
      tools: {
        read: tool({
          inputSchema: z.object({ path: z.string() }),
          outputSchema: z.object({ content: z.string() }),
          execute: async () => ({ content: "hello" })
        })
      }
    });

    const desc = await connector.describe();
    expect(desc.descriptors.read.outputSchema).toMatchObject({
      type: "object",
      properties: { content: { type: "string" } }
    });
  });

  it("resolves deferred input and output schemas before describing tools", async () => {
    const connector = new ToolSetConnector(ctx, {
      name: "workspace",
      tools: {
        deferred: tool({
          inputSchema: jsonSchema(async () => ({
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
          })),
          outputSchema: jsonSchema(
            Promise.resolve({
              type: "object",
              properties: { content: { type: "string" } },
              required: ["content"]
            })
          ),
          execute: async () => ({ content: "hello" })
        })
      }
    });

    const description = await connector.describe();
    expect(description.descriptors.deferred.inputSchema).toMatchObject({
      properties: { path: { type: "string" } }
    });
    expect(description.descriptors.deferred.outputSchema).toMatchObject({
      properties: { content: { type: "string" } }
    });
    const types = await connector.getTypeScriptTypes();
    expect(types).toContain("path: string");
    expect(types).toContain("content: string");
  });

  it("applies explicit per-tool Code Mode policies", async () => {
    const connector = new ToolSetConnector(ctx, {
      tools: {
        read: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "contents"
        }),
        write: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "written"
        })
      },
      policies: {
        read: { replay: "reexecute" },
        write: { requiresApproval: true }
      }
    });

    await expect(connector.describe()).resolves.toMatchObject({
      annotations: {
        read: { replay: "reexecute" },
        write: { requiresApproval: true }
      }
    });
  });

  it("rejects policies for unknown or non-executable tools", async () => {
    const connector = new ToolSetConnector(ctx, {
      tools: {},
      policies: { typo: { requiresApproval: true } }
    });

    await expect(connector.describe()).rejects.toThrow(
      'Policy for unknown or non-executable tool "typo"'
    );
  });

  it("excludes execute-less tools from both bindings and generated types", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connector = new ToolSetConnector(ctx, {
      tools: {
        serverSide: tool({
          description: "Runs on the server",
          inputSchema: z.object({}),
          execute: async () => "ran"
        }),
        clientSide: tool({
          description: "Forwarded to the client",
          inputSchema: z.object({ prompt: z.string() })
          // no execute — client-side tool
        })
      }
    });

    const desc = await connector.describe();
    expect(Object.keys(desc.descriptors)).toEqual(["serverSide"]);

    // The sandbox types must not advertise a method the sandbox can't call.
    const types = await connector.getTypeScriptTypes();
    expect(types).toContain("serverSide");
    expect(types).not.toContain("clientSide");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("clientSide");
  });

  it("rejects tools whose sanitized names collide", async () => {
    const connector = new ToolSetConnector(ctx, {
      tools: {
        "get-weather": tool({
          inputSchema: z.object({}),
          execute: async () => 1
        }),
        get_weather: tool({
          inputSchema: z.object({}),
          execute: async () => 2
        })
      }
    });

    await expect(connector.describe()).rejects.toThrow("get_weather");
  });
});
