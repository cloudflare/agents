import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  asAi,
  collectEvents,
  fakeBinding,
  field,
  sseResponse,
  workersAITextStream,
  workersAIToolStream
} from "./helpers";

const parameters = Type.Object({ city: Type.String() });

const getWeather: AgentTool<typeof parameters, Record<string, never>> = {
  description: "Get the current weather for a city",
  execute: async (_toolCallId, params) => ({
    content: [{ text: `${params.city}: clear, 21°C`, type: "text" }],
    details: {}
  }),
  label: "Weather",
  name: "getWeather",
  parameters
};

describe("pi-ai: pi-agent-core Agent", () => {
  it("runs a tool loop through streamFn", async () => {
    const binding = fakeBinding((_call, index) =>
      index === 0
        ? sseResponse(workersAIToolStream())
        : sseResponse(workersAITextStream())
    );
    const ai = createAI({ binding: asAi(binding) });
    const model = ai("@cf/zai-org/glm-4.7-flash", {
      sessionAffinity: "chat-1"
    });

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: "You can check the weather.",
        tools: [getWeather]
      },
      streamFn: ai.streamFn
    });
    await agent.prompt("What is the weather in London?");
    await agent.waitForIdle();

    expect(binding.calls).toHaveLength(2);
    // The second turn replays the tool call and its result.
    const replay = binding.calls[1]?.input;
    expect(field(replay, "messages.2.tool_calls.0.function.name")).toBe(
      "getWeather"
    );
    expect(field(replay, "messages.3.role")).toBe("tool");
    expect(String(field(replay, "messages.3.content"))).toContain("21°C");
    expect(binding.calls[1]?.options.extraHeaders).toMatchObject({
      "x-session-affinity": "chat-1"
    });

    const roles = agent.state.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const final = agent.state.messages.at(-1);
    expect(final?.role).toBe("assistant");
    expect(JSON.stringify(final)).toContain("Hello there");
  });

  it("exposes the same stream for direct use", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.streamFn(ai("@cf/zai-org/glm-4.7-flash"), {
        messages: [{ content: "hi", role: "user", timestamp: 1 }]
      }) as ReturnType<typeof ai.streamSimple>
    );
    expect(message.stopReason).toBe("stop");
  });
});
