import { describe, it, expect } from "vitest";
import { createToolsFromClientSchemas } from "../client-tools";

describe("createToolsFromClientSchemas", () => {
  it("returns an empty set for no schemas", () => {
    expect(createToolsFromClientSchemas()).toEqual({});
    expect(createToolsFromClientSchemas([])).toEqual({});
  });

  it("builds execute-less tools by default", () => {
    const tools = createToolsFromClientSchemas([
      { name: "get_time", description: "Get the time" }
    ]);
    expect(Object.keys(tools)).toEqual(["get_time"]);
    expect(tools.get_time.description).toBe("Get the time");
    // No execute — the model's call is meant to be sent back to the client.
    expect(tools.get_time.execute).toBeUndefined();
  });

  it("wires an execute that delegates to the supplied executor", async () => {
    const calls: Array<{
      toolName: string;
      input: unknown;
      toolCallId: string;
    }> = [];
    const tools = createToolsFromClientSchemas(
      [
        {
          name: "get_time",
          description: "Get the time",
          parameters: {
            type: "object",
            properties: { tz: { type: "string" } }
          }
        }
      ],
      {
        execute: (call) => {
          calls.push(call);
          return { now: "12:00" };
        }
      }
    );

    expect(typeof tools.get_time.execute).toBe("function");
    const output = await tools.get_time.execute!({ tz: "UTC" }, {
      toolCallId: "tc-1"
    } as never);
    expect(output).toEqual({ now: "12:00" });
    expect(calls).toEqual([
      { toolName: "get_time", input: { tz: "UTC" }, toolCallId: "tc-1" }
    ]);
  });

  it("falls back to an empty toolCallId when execute options are absent", async () => {
    let seen: string | undefined;
    const tools = createToolsFromClientSchemas([{ name: "ping" }], {
      execute: (call) => {
        seen = call.toolCallId;
        return "pong";
      }
    });
    const output = await tools.ping.execute!({}, undefined as never);
    expect(output).toBe("pong");
    expect(seen).toBe("");
  });
});
