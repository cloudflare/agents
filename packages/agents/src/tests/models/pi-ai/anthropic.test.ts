import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  WEATHER_TOOL_PARAMETERS,
  anthropicModel,
  anthropicTextEvents,
  anthropicToolEvents,
  asAi,
  collectEvents,
  fakeBinding,
  field,
  jsonResponse,
  sseEventResponse,
  userContext
} from "./helpers";

const OPUS = anthropicModel("claude-opus-4-8");
const SONNET = anthropicModel("claude-sonnet-4-5");

describe("pi-ai: Anthropic Messages over the universal gateway", () => {
  it("sends the vendor's own body to the anthropic provider", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding), id: "gw" });
    await collectEvents(
      ai.streamSimple(ai(SONNET), userContext("hi", "be brief"), {
        maxTokens: 64
      })
    );

    const call = binding.universal[0];
    expect(binding.calls).toHaveLength(0);
    expect(call?.gatewayId).toBe("gw");
    expect(call?.provider).toBe("anthropic");
    expect(call?.endpoint).toBe("v1/messages");
    // The gateway holds the key: no vendor credential header is sent.
    expect(call?.headers).toMatchObject({ "anthropic-version": "2023-06-01" });
    expect(Object.keys(call?.headers ?? {})).not.toContain("x-api-key");
    expect(Object.keys(call?.headers ?? {})).not.toContain("authorization");
    // The vendor's own id spelling, untouched.
    expect(field(call?.query, "model")).toBe("claude-sonnet-4-5");
    expect(field(call?.query, "stream")).toBe(true);
    expect(field(call?.query, "max_tokens")).toBe(64);
    expect(JSON.stringify(field(call?.query, "system"))).toContain("be brief");
    expect(field(call?.query, "messages.0.role")).toBe("user");
  });

  it("parses a text stream in the live event shape", async () => {
    const binding = fakeBinding(() =>
      sseEventResponse(anthropicTextEvents(), {
        headers: { "cf-aig-log-id": "log-a", "cf-aig-trace-id": "trace-a" }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(SONNET), userContext("hi"))
    );
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("done");
    expect(message.content).toEqual([{ text: "Hi there!", type: "text" }]);
    expect(message.stopReason).toBe("stop");
    // The model's own identity is kept, so a later turn replaying a thinking
    // block is recognised as the same model.
    expect(message.model).toBe("claude-sonnet-4-5");
    expect(message.provider).toBe("anthropic");
    expect(message.api).toBe("anthropic-messages");
    expect(message.usage.input).toBe(14);
    expect(message.usage.output).toBe(8);
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare")?.details
    ).toMatchObject({
      gateway: "default",
      logId: "log-a",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      traceId: "trace-a"
    });
  });

  it("parses a streamed tool use and asks for the streaming beta", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicToolEvents()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(SONNET), {
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
    const call = binding.universal[0];
    expect(field(call?.query, "tools.0.name")).toBe("getWeather");
    expect(field(call?.query, "tools.0.input_schema")).toBeDefined();
    // pi-ai defaults `supportsEagerToolInputStreaming` to true, so a model
    // that does not declare it asks for no fine-grained beta at all.
    expect(call?.headers["anthropic-beta"]).not.toContain(
      "fine-grained-tool-streaming-2025-05-14"
    );
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[0]).toMatchObject({
      arguments: { city: "London" },
      id: "toolu_0155RDpmUnKdRHZkMrjAqgwL",
      name: "getWeather",
      type: "toolCall"
    });
  });

  it("takes the thinking shape from the model's own compat profile", async () => {
    // opus-4.8 declares `forceAdaptiveThinking`, so pi asks for an effort;
    // sonnet-4-5 does not, so pi budgets tokens. Neither rule is ours.
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.streamSimple(ai(OPUS), userContext("hi"), {
        maxTokens: 4096,
        reasoning: "medium"
      })
    );
    await collectEvents(
      ai.streamSimple(ai(SONNET), userContext("hi"), {
        maxTokens: 4096,
        reasoning: "medium"
      })
    );

    const adaptive = binding.universal[0]?.query;
    expect(field(adaptive, "thinking.type")).toBe("adaptive");
    expect(field(adaptive, "thinking.budget_tokens")).toBeUndefined();
    // An adaptive model has interleaved thinking built in, and this turn has
    // no tools, so pi asks for no beta at all.
    expect(binding.universal[0]?.headers["anthropic-beta"]).toBeUndefined();

    const budgeted = binding.universal[1]?.query;
    expect(field(budgeted, "thinking.type")).toBe("enabled");
    expect(field(budgeted, "thinking.budget_tokens")).toBeGreaterThan(0);
    expect(binding.universal[1]?.headers["anthropic-beta"]).toContain(
      "interleaved-thinking-2025-05-14"
    );
  });

  it("replays a thinking block with its signature on the next turn", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.stream(ai(SONNET), {
        messages: [
          { content: "hi", role: "user", timestamp: 1 },
          {
            api: "anthropic-messages",
            content: [
              {
                thinking: "Let me think.",
                thinkingSignature: "sig-1",
                type: "thinking"
              },
              { text: "Hello.", type: "text" }
            ],
            model: "claude-sonnet-4-5",
            provider: "anthropic",
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
    const replayed = field(binding.universal[0]?.query, "messages.1.content.0");
    expect(replayed).toMatchObject({
      signature: "sig-1",
      thinking: "Let me think.",
      type: "thinking"
    });
  });

  it("terminates with an error event on a gateway error envelope", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          error: [
            {
              code: 2021,
              message:
                "This model is not available via unified billing. Please use BYOK."
            }
          ],
          name: "AiGatewayError",
          success: false
        },
        { headers: { "cf-aig-log-id": "log-402" }, status: 402 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(OPUS), userContext("hi"))
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("unified billing");
    // The gateway's own failure is reported with the typed diagnostic the
    // other two wires attach, not as pi-ai's bare error event.
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare-error")?.details
    ).toMatchObject({ code: "gateway-error", status: 402 });
    // The correlation ids are read off the raw response, before the envelope
    // check throws, so they survive a failure too.
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare")?.details
    ).toMatchObject({ logId: "log-402", provider: "anthropic" });
  });

  it("reports a vendor's own non-2xx with the cloudflare-error diagnostic", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          error: { message: "overloaded", type: "overloaded_error" },
          type: "error"
        },
        { headers: { "cf-aig-log-id": "log-529" }, status: 529 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(SONNET), userContext("hi"))
    );
    expect(message.stopReason).toBe("error");
    expect(
      message.diagnostics?.find((d) => d.type === "cloudflare-error")?.details
    ).toMatchObject({ logId: "log-529", status: 529 });
  });

  it("asks for the fine-grained beta only when the model declares it", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicToolEvents()));
    const ai = createAI({ binding: asAi(binding) });
    const eager: Model<Api> = {
      ...SONNET,
      compat: { supportsEagerToolInputStreaming: false }
    };
    await collectEvents(
      ai.stream(ai(eager), {
        messages: [{ content: "Weather?", role: "user", timestamp: 1 }],
        tools: [
          {
            description: "Get weather",
            name: "getWeather",
            parameters: WEATHER_TOOL_PARAMETERS as never
          }
        ]
      })
    );
    expect(binding.universal[0]?.headers["anthropic-beta"]).toContain(
      "fine-grained-tool-streaming-2025-05-14"
    );
  });

  it("honours the caller's `interleavedThinking: false`", async () => {
    const binding = fakeBinding(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.provider.stream(ai(SONNET), userContext("hi"), {
        interleavedThinking: false
      })
    );
    expect(binding.universal[0]?.headers["anthropic-beta"]).toBeUndefined();
  });
});
