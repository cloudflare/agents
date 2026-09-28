import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { activeDeferredTools, searchDeferredTools } from "../tool-discovery";

function agent(name: string) {
  return getAgentByName(env.ThinkToolDiscoveryAgent, name);
}

const synthetic = (names: string[]) => names.filter((n) => /^tool_/.test(n));

describe("deferred tool discovery (#2277)", () => {
  it("sends only eager tools and discovery until the model finds a tool", async () => {
    const report = await (
      await agent("discover-and-call")
    ).runTurnForTest([
      { tool: "discover_tools", input: { query: "weather forecast" } },
      { tool: "tool_42" },
      { text: "It is sunny." }
    ]);

    const [first, second, third] = report.requests;
    expect(first).toContain("discover_tools");
    expect(first).toContain("eager_echo");
    expect(synthetic(first)).toEqual([]);
    expect(first).not.toContain("admin_action");

    expect(report.discoveryOutputs).toEqual([{ activated: ["tool_42"] }]);
    expect(synthetic(second)).toEqual(["tool_42"]);
    expect(synthetic(third)).toEqual(["tool_42"]);
    expect(report.beforeToolCalls).toContain("tool_42");
    expect(report.executed).toEqual(["tool_42"]);
  });

  it("keeps a discovered tool active on later turns, from the transcript", async () => {
    const stub = await agent("discover-persists");
    await stub.runTurnForTest([
      { tool: "discover_tools", input: { query: "tool_3 tool_4" } },
      { text: "Loaded." }
    ]);
    const next = await stub.runTurnForTest([{ text: "Still here." }]);
    expect(synthetic(next.requests[0])).toEqual(["tool_3", "tool_4"]);
  });

  it("neither lists nor runs a deferred action the turn is not authorized for", async () => {
    const report = await (
      await agent("discover-unauthorized")
    ).runTurnForTest([
      { tool: "discover_tools", input: { query: "admin_action weather" } },
      { tool: "admin_action" },
      { text: "Could not." }
    ]);
    expect(report.discoveryOutputs).toEqual([{ activated: ["tool_42"] }]);
    expect(report.requests.flat()).not.toContain("admin_action");
    expect(report.executed).toEqual([]);
    expect(report.beforeToolCalls).not.toContain("admin_action");
  });

  it("ignores names a custom search returns outside the catalog", async () => {
    const report = await (
      await agent("discover-custom-search")
    ).runTurnForTest(
      [
        { tool: "discover_tools", input: { query: "anything" } },
        { text: "ok" }
      ],
      { customSearch: true }
    );
    expect(report.discoveryOutputs).toEqual([{ activated: ["tool_7"] }]);
    expect(synthetic(report.requests[1])).toEqual(["tool_7"]);
    expect(report.requests[1]).not.toContain("admin_action");
  });

  it("does not let discovery reach past beforeTurn's activeTools", async () => {
    const report = await (
      await agent("discover-narrowed")
    ).runTurnForTest(
      [
        { tool: "discover_tools", input: { query: "tool_42 tool_1" } },
        { text: "ok" }
      ],
      { activeTools: ["eager_echo", "tool_1"] }
    );
    expect(report.requests[0]).toEqual(["eager_echo", "discover_tools"]);
    expect(report.requests[1]).toEqual([
      "eager_echo",
      "tool_1",
      "discover_tools"
    ]);
  });
});

describe("tool discovery helpers", () => {
  const catalog = [
    { name: "get_weather", description: "Current conditions" },
    { name: "send_email", description: "Send an email about the weather" },
    { name: "list_files", description: "List files" }
  ];

  it("puts exact names first, then name matches ahead of description matches", () => {
    expect(searchDeferredTools("list_files weather", catalog)).toEqual([
      "list_files",
      "get_weather",
      "send_email"
    ]);
    expect(searchDeferredTools("weather", catalog, 1)).toEqual(["get_weather"]);
    expect(searchDeferredTools("zz", catalog)).toEqual([]);
  });

  it("derives activation from discovery results and calls, ignoring others", () => {
    const active = activeDeferredTools(
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "a",
                toolName: "list_files",
                input: {}
              }
            ]
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "b",
                toolName: "discover_tools",
                output: {
                  type: "json",
                  value: {
                    activated: ["get_weather", "admin_action"]
                  }
                }
              },
              {
                type: "tool-result",
                toolCallId: "c",
                toolName: "other_tool",
                output: {
                  type: "json",
                  value: { activated: ["send_email"] }
                }
              }
            ]
          }
        ]
      },
      "discover_tools",
      catalog
    );
    expect([...active].sort()).toEqual(["get_weather", "list_files"]);
  });

  it("reads a discovery result from the transcript when the model copy was truncated", () => {
    const truncatedOnly = {
      messages: [
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "d",
              toolName: "discover_tools",
              output: { type: "text" as const, value: '{"activated":["get_w…' }
            }
          ]
        }
      ]
    };
    expect(
      activeDeferredTools(truncatedOnly, "discover_tools", catalog).size
    ).toBe(0);
    const active = activeDeferredTools(
      {
        ...truncatedOnly,
        transcript: [
          {
            id: "m",
            role: "assistant",
            parts: [
              {
                type: "tool-discover_tools",
                toolCallId: "d",
                state: "output-available",
                input: { query: "weather" },
                output: { activated: ["get_weather"] }
              },
              {
                type: "dynamic-tool",
                toolName: "send_email",
                toolCallId: "e",
                state: "input-available",
                input: {}
              }
            ]
          }
        ]
      },
      "discover_tools",
      catalog
    );
    expect([...active].sort()).toEqual(["get_weather", "send_email"]);
  });
});
