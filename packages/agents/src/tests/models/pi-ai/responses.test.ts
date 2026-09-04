import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  WEATHER_TOOL_PARAMETERS,
  asAi,
  collectEvents,
  fakeBinding,
  field,
  gatewayPadded,
  jsonResponse,
  openaiModel,
  responsesTextStream,
  responsesToolStream,
  sseResponse,
  userContext
} from "./helpers";

const MODEL = openaiModel("gpt-5-mini");

describe("pi-ai: OpenAI Responses over the universal gateway", () => {
  it("sends a Responses body to the openai provider", async () => {
    const binding = fakeBinding(() =>
      sseResponse(gatewayPadded(responsesTextStream()))
    );
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.streamSimple(ai(MODEL), userContext("hi", "be brief"), {
        maxTokens: 4,
        reasoning: "low",
        sessionId: "session-1"
      })
    );

    const call = binding.universal[0];
    expect(binding.calls).toHaveLength(0);
    expect(call?.provider).toBe("openai");
    expect(call?.endpoint).toBe("v1/responses");
    expect(Object.keys(call?.headers ?? {})).not.toContain("authorization");
    expect(field(call?.query, "model")).toBe("gpt-5-mini");
    expect(field(call?.query, "stream")).toBe(true);
    expect(field(call?.query, "store")).toBe(false);
    expect(field(call?.query, "max_output_tokens")).toBe(16);
    expect(field(call?.query, "reasoning")).toEqual({
      effort: "low",
      summary: "auto"
    });
    expect(field(call?.query, "include")).toEqual([
      "reasoning.encrypted_content"
    ]);
    expect(field(call?.query, "prompt_cache_key")).toBe("session-1");
    expect(field(call?.query, "messages")).toBeUndefined();
    const input = field(call?.query, "input") as unknown[];
    expect(Array.isArray(input)).toBe(true);
    expect(JSON.stringify(input)).toContain("be brief");
    expect(JSON.stringify(input)).toContain('"hi"');
  });

  it("parses a text response through the gateway's padded events", async () => {
    const binding = fakeBinding(() =>
      sseResponse(gatewayPadded(responsesTextStream()), {
        headers: { "cf-aig-run-id": "run-1" }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("done");
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toMatchObject({
      text: "Hi there",
      type: "text"
    });
    expect(message.stopReason).toBe("stop");
    expect(message.usage.output).toBe(5);
    expect(message.model).toBe("gpt-5-mini");
    expect(message.provider).toBe("openai");
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare")?.details
    ).toMatchObject({ provider: "openai", runId: "run-1" });
  });

  it("parses a streamed function call", async () => {
    const binding = fakeBinding(() => sseResponse(responsesToolStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), {
        messages: [
          { content: "Weather in London?", role: "user", timestamp: 1 }
        ],
        tools: [
          {
            description: "Get weather",
            name: "getWeather",
            parameters: WEATHER_TOOL_PARAMETERS as never
          }
        ]
      })
    );
    expect(field(binding.universal[0]?.query, "tools.0.name")).toBe(
      "getWeather"
    );
    expect(message.stopReason).toBe("toolUse");
    const call = message.content.find((c) => c.type === "toolCall");
    expect(call).toMatchObject({
      arguments: { city: "London" },
      name: "getWeather"
    });
    expect(message.usage.output).toBe(40);
    expect(message.usage.totalTokens).toBe(120);
  });

  it("replays an encrypted reasoning item on the next turn", async () => {
    const binding = fakeBinding(() => sseResponse(responsesTextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const encrypted = JSON.stringify({
      encrypted_content: "gAAAAABqmZk3",
      id: "rs_1",
      summary: [],
      type: "reasoning"
    });
    await collectEvents(
      ai.stream(ai(MODEL), {
        messages: [
          { content: "hi", role: "user", timestamp: 1 },
          {
            api: "openai-responses",
            content: [
              {
                thinking: "",
                thinkingSignature: encrypted,
                type: "thinking"
              },
              { text: "Hello.", type: "text" }
            ],
            model: "gpt-5-mini",
            provider: "openai",
            role: "assistant",
            stopReason: "stop",
            timestamp: 2,
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 0,
                output: 0,
                total: 0
              },
              input: 0,
              output: 0,
              totalTokens: 0
            }
          },
          { content: "and again?", role: "user", timestamp: 3 }
        ]
      })
    );
    const input = field(binding.universal[0]?.query, "input") as unknown[];
    expect(input).toContainEqual({
      encrypted_content: "gAAAAABqmZk3",
      id: "rs_1",
      summary: [],
      type: "reasoning"
    });
  });

  it("surfaces the gateway's own error envelope", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          error: [{ code: 2021, message: "Insufficient balance" }],
          name: "AiGatewayError",
          success: false
        },
        { status: 402 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Insufficient balance");
  });
});

describe("pi-ai: the reasoning level is the model's to decide", () => {
  it("forwards a level the model's own thinkingLevelMap declares", async () => {
    const binding = fakeBinding(() =>
      sseResponse(gatewayPadded(responsesTextStream()))
    );
    const ai = createAI({ binding: asAi(binding) });
    // pi-ai's registry gives `gpt-5.2` `thinkingLevelMap: { xhigh: "xhigh" }`,
    // so `xhigh` survives — because the registry says so, not because of any
    // effort table of ours.
    await collectEvents(
      ai.streamSimple(ai("openai/gpt-5.2"), userContext("hi"), {
        reasoning: "xhigh"
      })
    );
    await collectEvents(
      ai.streamSimple(ai("openai/gpt-5.2"), userContext("hi"), {
        reasoning: "minimal"
      })
    );
    expect(field(binding.universal[0]?.query, "reasoning.effort")).toBe(
      "xhigh"
    );
    expect(field(binding.universal[1]?.query, "reasoning.effort")).toBe(
      "minimal"
    );
  });

  it("forwards an explicitly named level unchanged", async () => {
    const binding = fakeBinding(() =>
      sseResponse(gatewayPadded(responsesTextStream()))
    );
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.stream(ai("openai/gpt-5.2"), userContext("hi"), {
        reasoningEffort: "xhigh"
      } as never)
    );
    expect(field(binding.universal[0]?.query, "reasoning.effort")).toBe(
      "xhigh"
    );
  });

  it("omits reasoning entirely when the model declares `off: null`", async () => {
    const binding = fakeBinding(() =>
      sseResponse(gatewayPadded(responsesTextStream()))
    );
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(ai.stream(ai(MODEL), userContext("hi")));
    // `gpt-5-mini` declares `thinkingLevelMap: { off: null }`, i.e. it cannot
    // be asked for no reasoning at all.
    expect(field(binding.universal[0]?.query, "reasoning")).toBeUndefined();
  });
});
