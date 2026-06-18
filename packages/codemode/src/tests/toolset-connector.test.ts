import { tool } from "ai";
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
