import type {
  AssistantMessage,
  Context,
  ToolResultMessage
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  WEATHER_TOOL_PARAMETERS,
  anthropicTextEvents,
  asAi,
  collectEvents,
  fakeBinding,
  field,
  sseEventResponse,
  sseResponse,
  userContext,
  workersAITextStream,
  workersAIToolStream
} from "./helpers";

const WORKERS_AI = "@cf/zai-org/glm-4.7-flash";

/**
 * `ai.streamFn` is `streamSimple`, bound, for code that takes a stream
 * function rather than a provider: it is called detached, with a raw pi-ai
 * `Context` whose tools and system prompt are fields, once per turn.
 */
describe("pi-ai: ai.streamFn", () => {
  it("runs a tool loop when called detached, turn by turn", async () => {
    const binding = fakeBinding((_call, index) =>
      index === 0
        ? sseResponse(workersAIToolStream())
        : sseResponse(workersAITextStream())
    );
    const ai = createAI({ binding: asAi(binding) });
    const { streamFn } = ai;
    const model = ai(WORKERS_AI, { sessionAffinity: "chat-1" });
    const context: Context = {
      messages: [
        {
          content: "What is the weather in London?",
          role: "user",
          timestamp: 1
        }
      ],
      systemPrompt: "You can check the weather.",
      tools: [
        {
          description: "Get the current weather for a city",
          name: "getWeather",
          parameters: WEATHER_TOOL_PARAMETERS as never
        }
      ]
    };

    const first = await collectEvents(streamFn(model, context));
    expect(first.message.stopReason).toBe("toolUse");
    const call = first.message.content.find((part) => part.type === "toolCall");
    expect(call).toMatchObject({
      arguments: { city: "London" },
      name: "getWeather"
    });
    if (call?.type !== "toolCall") throw new Error("expected a tool call");

    const result: ToolResultMessage = {
      content: [{ text: "London: clear, 21°C", type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: 2,
      toolCallId: call.id,
      toolName: call.name
    };
    const second = await collectEvents(
      streamFn(model, {
        ...context,
        messages: [...context.messages, first.message, result]
      })
    );

    expect(binding.calls).toHaveLength(2);
    for (const run of binding.calls) {
      // The tools and the system prompt come from the raw context each turn.
      expect(field(run.input, "tools.0.function.name")).toBe("getWeather");
      expect(field(run.input, "messages.0.role")).toBe("system");
      expect(run.options.extraHeaders).toMatchObject({
        "x-session-affinity": "chat-1"
      });
    }
    // The second turn replays the tool call and its result.
    const replay = binding.calls[1]?.input;
    expect(field(replay, "messages.2.tool_calls.0.function.name")).toBe(
      "getWeather"
    );
    expect(field(replay, "messages.3.role")).toBe("tool");
    expect(String(field(replay, "messages.3.content"))).toContain("21°C");

    expect(second.message.stopReason).toBe("stop");
    expect(textOf(second.message)).toBe("Hello there");
    expect(second.events.at(-1)?.type).toBe("done");
  });

  it("takes simple options: a reasoning level and a token cap", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.streamFn(ai(WORKERS_AI), userContext("hi"), {
        maxTokens: 32,
        reasoning: "minimal"
      })
    );

    expect(message.stopReason).toBe("stop");
    const input = binding.calls[0]?.input;
    // A pi thinking level, mapped onto Workers AI's effort scale.
    expect(field(input, "reasoning_effort")).toBe("low");
    expect(field(input, "max_tokens")).toBe(32);
  });

  it("routes a gateway model as streamSimple does", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding), id: "gw" });
    const { message } = await collectEvents(
      ai.streamFn(ai("anthropic/claude-opus-4.8"), userContext("hi"))
    );

    expect(binding.calls).toHaveLength(0);
    expect(binding.universal[0]).toMatchObject({
      endpoint: "v1/messages",
      gatewayId: "gw",
      provider: "anthropic"
    });
    expect(message.stopReason).toBe("stop");
  });
});

function textOf(message: AssistantMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
