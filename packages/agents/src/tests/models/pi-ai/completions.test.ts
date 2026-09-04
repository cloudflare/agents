import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAI, CLOUDFLARE_DIAGNOSTIC } from "../../../models/pi-ai";
import {
  WEATHER_TOOL_PARAMETERS,
  asAi,
  billingError,
  collectEvents,
  fakeBinding,
  field,
  groqModel,
  jsonResponse,
  sseResponse,
  userContext,
  workersAITextStream,
  workersAIToolJson,
  workersAIToolStream
} from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";

describe("pi-ai: Workers AI chat completions", () => {
  it("streams reasoning and text in the live stream shape", async () => {
    const binding = fakeBinding(() =>
      sseResponse(workersAITextStream(), {
        headers: { "cf-aig-log-id": "log-1", "cf-aig-cache-status": "MISS" }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );

    expect(events[0]?.type).toBe("start");
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done"
    ]);
    // The signature names the field the reasoning came back in, so pi replays
    // it as `reasoning_content` rather than as plain text on the next turn.
    expect(message.content).toEqual([
      {
        thinking: "Thinking",
        thinkingSignature: "reasoning_content",
        type: "thinking"
      },
      { text: "Hello there", type: "text" }
    ]);
    expect(message.stopReason).toBe("stop");
    // The native tail carries the cumulative usage; per-delta usage is not it.
    expect(message.usage.input).toBe(11);
    expect(message.usage.output).toBe(64);
    expect(message.usage.totalTokens).toBe(75);
    expect(message.model).toBe(MODEL);
    expect(message.provider).toBe("cloudflare");
    expect(message.responseId).toBe("chatcmpl-976ebec0943daf97");
    const diagnostic = message.diagnostics?.find(
      (d) => d.type === CLOUDFLARE_DIAGNOSTIC
    );
    expect(diagnostic?.details).toMatchObject({
      cacheStatus: "MISS",
      gateway: "default",
      logId: "log-1",
      model: MODEL
    });
  });

  it("sends the chat-completions body through the binding with gateway options", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({
      binding: asAi(binding),
      gateway: { id: "my-gateway", metadata: { app: "test" } }
    });
    const model = ai(MODEL, {
      cacheTtl: 60,
      chatTemplateKwargs: { enable_thinking: false },
      sessionAffinity: "session-1"
    });
    await collectEvents(
      ai.streamSimple(model, userContext("hi", "be brief"), {
        maxTokens: 32,
        metadata: { user: "u1" },
        reasoning: "low",
        temperature: 0.2
      })
    );

    const call = binding.calls[0];
    expect(call?.model).toBe(MODEL);
    expect(call?.options).toMatchObject({
      extraHeaders: { "x-session-affinity": "session-1" },
      gateway: {
        cacheTtl: 60,
        id: "my-gateway",
        metadata: { app: "test", user: "u1" }
      },
      returnRawResponse: true
    });
    expect(field(call?.input, "stream")).toBe(true);
    expect(field(call?.input, "max_tokens")).toBe(32);
    expect(field(call?.input, "temperature")).toBe(0.2);
    expect(field(call?.input, "reasoning_effort")).toBe("low");
    expect(field(call?.input, "chat_template_kwargs")).toEqual({
      enable_thinking: false
    });
    expect(field(call?.input, "messages.0")).toEqual({
      content: "be brief",
      role: "system"
    });
    expect(field(call?.input, "messages.1")).toEqual({
      content: "hi",
      role: "user"
    });
    expect(field(call?.input, "model")).toBeUndefined();
  });

  it("does not send the affinity header for third-party models", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.streamSimple(
        ai(groqModel("llama-3.1-8b-instant")),
        userContext("hi"),
        { sessionId: "s" }
      )
    );
    expect(binding.universal[0]?.options.extraHeaders).toBeUndefined();
  });

  it("emits a tool call that arrives complete in one delta", async () => {
    const binding = fakeBinding(() => sseResponse(workersAIToolStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.streamSimple(ai(MODEL), {
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

    expect(field(binding.calls[0]?.input, "tools.0.function.name")).toBe(
      "getWeather"
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done"
    ]);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[1]).toEqual({
      arguments: { city: "London" },
      id: "chatcmpl-tool-8a8be1fee2f66115",
      name: "getWeather",
      type: "toolCall"
    });
    expect(message.usage.totalTokens).toBe(241);
  });

  it("turns a non-streaming JSON body into a one-shot stream", async () => {
    const binding = fakeBinding(() => jsonResponse(workersAIToolJson()));
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("Weather in London?"))
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done"
    ]);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[1]).toMatchObject({
      arguments: { city: "London" },
      name: "getWeather"
    });
    expect(message.usage.input).toBe(100);
  });

  it("terminates with an error event on a gateway error response", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(billingError(), {
        headers: { "cf-aig-log-id": "log-err" },
        status: 402
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(groqModel("llama-3.1-8b-instant")), userContext("hi"))
    );
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Insufficient balance");
    const diagnostic = message.diagnostics?.find(
      (d) => d.type === "cloudflare-error"
    );
    expect(diagnostic?.details).toMatchObject({
      logId: "log-err",
      status: 402
    });
  });

  it("reports an abort as aborted", async () => {
    const controller = new AbortController();
    const binding = fakeBinding(() => {
      controller.abort();
      const error = new DOMException(
        "The operation was aborted.",
        "AbortError"
      );
      throw error;
    });
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"), { signal: controller.signal })
    );
    expect(message.stopReason).toBe("aborted");
  });

  it("uses complete() to return the final message", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const message = await ai.complete(ai(MODEL), userContext("hi"));
    expect(message.content).toContainEqual({
      text: "Hello there",
      type: "text"
    });
  });
});

describe("pi-ai: vendor usage on the chat-completions wire", () => {
  it("counts Google's reasoning tokens, which sit outside completion_tokens, in output", async () => {
    // Live google/gemini-3-flash: prompt 6 + completion 3 + reasoning 57 = 66.
    const binding = fakeBinding(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: { content: "Hi!", role: "assistant" }
          }
        ],
        id: "chatcmpl-g",
        model: "google/gemini-3-flash-preview",
        object: "chat.completion",
        usage: {
          completion_tokens: 3,
          completion_tokens_details: { reasoning_tokens: 57 },
          prompt_tokens: 6,
          total_tokens: 66
        }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const message = await ai.complete(
      ai(groqModel("llama-3.1-8b-instant")),
      userContext("hi")
    );
    expect(message.usage.input).toBe(6);
    expect(message.usage.output).toBe(60);
    // `reasoning` rides on the usage object without being in pi-ai's type.
    expect((message.usage as { reasoning?: number }).reasoning).toBe(57);
    expect(message.usage.totalTokens).toBe(66);
  });
});

describe("pi-ai: vendor reasoning and tool calls on the chat-completions wire", () => {
  /** A vendor chunk in the strict OpenAI streaming shape. */
  function vendorChunk(
    delta: Record<string, unknown>,
    finishReason: string | null = null
  ): string {
    return JSON.stringify({
      choices: [{ delta, finish_reason: finishReason, index: 0 }],
      id: "chatcmpl-vendor",
      model: "llama-3.1-8b-instant",
      object: "chat.completion.chunk"
    });
  }

  it("reads a reasoning delta under whichever field the vendor sends", async () => {
    // Groq, OpenRouter and router.huggingface.co spell it `reasoning`; the
    // Workers AI compat layer is what turns that into `reasoning_content`,
    // and a routed vendor model never goes through it.
    const binding = fakeBinding(() =>
      sseResponse([
        vendorChunk({ reasoning: "let me think", role: "assistant" }),
        vendorChunk({ content: "hi" }, "stop"),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(groqModel("llama-3.1-8b-instant")), userContext("hi"))
    );

    // The signature names the field, so pi replays the thinking under it.
    expect(message.content[0]).toMatchObject({
      thinking: "let me think",
      thinkingSignature: "reasoning",
      type: "thinking"
    });
    expect(message.content[1]).toEqual({ text: "hi", type: "text" });
  });

  it("takes the first non-empty reasoning field and no other", async () => {
    // Some endpoints send the same text twice; reading both would double it.
    const binding = fakeBinding(() =>
      sseResponse([
        vendorChunk({ reasoning: "once", reasoning_content: "once" }),
        vendorChunk({ content: "hi" }, "stop"),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(groqModel("llama-3.1-8b-instant")), userContext("hi"))
    );
    expect(message.content[0]).toMatchObject({
      thinking: "once",
      thinkingSignature: "reasoning_content"
    });
  });

  it("keeps `reasoning_content` as the signature on Workers AI", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );
    expect(message.content[0]).toMatchObject({
      thinkingSignature: "reasoning_content",
      type: "thinking"
    });
  });

  /** A complete (non-streamed) body with two parallel tool calls. */
  function parallelToolJson(model: string): Record<string, unknown> {
    return {
      choices: [
        {
          finish_reason: "tool_calls",
          index: 0,
          message: {
            content: null,
            role: "assistant",
            // A complete message carries no `index`: OpenAI's schema has one
            // only on streaming deltas, so array position is the index.
            tool_calls: [
              {
                function: {
                  arguments: '{"city":"London"}',
                  name: "getWeather"
                },
                id: "call_a",
                type: "function"
              },
              {
                function: { arguments: '{"city":"Paris"}', name: "getWeather" },
                id: "call_b",
                type: "function"
              }
            ]
          }
        }
      ],
      id: "chatcmpl-parallel",
      model,
      object: "chat.completion",
      usage: { completion_tokens: 5, prompt_tokens: 10, total_tokens: 15 }
    };
  }

  it("keeps parallel tool calls apart in a vendor's JSON body", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(parallelToolJson("llama-3.1-8b-instant"))
    );
    const ai = createAI({ binding: asAi(binding) });
    const { events, message } = await collectEvents(
      ai.stream(ai(groqModel("llama-3.1-8b-instant")), userContext("weather?"))
    );

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      {
        arguments: { city: "London" },
        id: "call_a",
        name: "getWeather",
        type: "toolCall"
      },
      {
        arguments: { city: "Paris" },
        id: "call_b",
        name: "getWeather",
        type: "toolCall"
      }
    ]);
    expect(events.filter((e) => e.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(2);
  });

  it("keeps them apart in the Workers AI twin of that body", async () => {
    const binding = fakeBinding(() => jsonResponse(parallelToolJson(MODEL)));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("weather?"))
    );
    expect(message.content.map((part) => part.type)).toEqual([
      "toolCall",
      "toolCall"
    ]);
    expect(message.content[1]).toMatchObject({
      arguments: { city: "Paris" },
      id: "call_b"
    });
  });
});

describe("pi-ai: cached input on the chat-completions wire", () => {
  /** A DeepSeek-shaped final chunk: cache hits under its own field name. */
  function usageBody(usage: Record<string, unknown>): Record<string, unknown> {
    return {
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { content: "Hi!", role: "assistant" }
        }
      ],
      id: "chatcmpl-cache",
      model: "llama-3.1-8b-instant",
      object: "chat.completion",
      usage
    };
  }

  it("counts DeepSeek's `prompt_cache_hit_tokens` as cache reads", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        usageBody({
          completion_tokens: 10,
          prompt_cache_hit_tokens: 900,
          prompt_cache_miss_tokens: 100,
          prompt_tokens: 1000,
          total_tokens: 1010
        })
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    // The prices are the model's own — a model object brings its metadata.
    const priced: Model<Api> = {
      ...groqModel("llama-3.1-8b-instant"),
      cost: { cacheRead: 0.0028, cacheWrite: 0, input: 0.14, output: 0.28 }
    };
    const message = await ai.complete(ai(priced), userContext("hi"));

    // Cached input is priced as a cache read, not as fresh input.
    expect(message.usage.cacheRead).toBe(900);
    expect(message.usage.input).toBe(100);
    expect(message.usage.cost.input).toBeCloseTo(0.000014, 12);
    expect(message.usage.cost.cacheRead).toBeCloseTo(0.00000252, 12);
  });

  it("reads `cache_write_tokens` out of `prompt_tokens_details`", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        usageBody({
          completion_tokens: 10,
          prompt_tokens: 1000,
          prompt_tokens_details: {
            cache_write_tokens: 200,
            cached_tokens: 300
          },
          total_tokens: 1010
        })
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const message = await ai.complete(
      ai(groqModel("llama-3.1-8b-instant")),
      userContext("hi")
    );

    // pi-ai's rule: writes come out of `input`, never out of `cacheRead`.
    expect(message.usage.cacheRead).toBe(300);
    expect(message.usage.cacheWrite).toBe(200);
    expect(message.usage.input).toBe(500);
  });
});

describe("pi-ai: the vendor's own compat profile decides the body", () => {
  /** A vendor chat-completions model, with the compat profile under test. */
  function vendorModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
    return {
      ...groqModel("llama-3.1-8b-instant"),
      reasoning: true,
      ...overrides
    };
  }

  it("drops the Workers-AI-only knobs on a routed vendor model", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(
        ai(groqModel("llama-3.1-8b-instant"), {
          chatTemplateKwargs: { enable_thinking: false },
          reasoningEffort: null
        }),
        userContext("hi")
      )
    );

    const query = binding.universal[0]?.query;
    expect(query).not.toHaveProperty("chat_template_kwargs");
    expect(query).not.toHaveProperty("reasoning_effort");
    const warnings = (
      message.diagnostics?.find((d) => d.type === "cloudflare-compat")
        ?.details as { warnings: { feature: string }[] } | undefined
    )?.warnings;
    expect(warnings?.map((warning) => warning.feature)).toEqual([
      "reasoning-off",
      "chat-template-kwargs"
    ]);
  });

  it("omits reasoning_effort when the model says it is unsupported", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.streamSimple(
        ai(vendorModel({ compat: { supportsReasoningEffort: false } })),
        userContext("hi"),
        { reasoning: "high" }
      )
    );
    expect(binding.universal[0]?.query).not.toHaveProperty("reasoning_effort");
  });

  it("remaps the level through the model's own thinkingLevelMap", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.streamSimple(
        ai(vendorModel({ thinkingLevelMap: { xhigh: "max" } })),
        userContext("hi"),
        { reasoning: "xhigh" }
      )
    );
    expect(binding.universal[0]?.query.reasoning_effort).toBe("max");
  });

  it("says so when the model asks for a thinking shape this wire does not build", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.streamSimple(
        ai(vendorModel({ compat: { thinkingFormat: "zai" } })),
        userContext("hi"),
        { reasoning: "high" }
      )
    );
    expect(binding.universal[0]?.query).not.toHaveProperty("reasoning_effort");
    const warnings = (
      message.diagnostics?.find((d) => d.type === "cloudflare-compat")
        ?.details as { warnings: { feature: string }[] } | undefined
    )?.warnings;
    expect(warnings?.map((warning) => warning.feature)).toEqual([
      "reasoning-effort"
    ]);
  });

  it("still sends the Workers AI knobs on a Workers AI model", async () => {
    const binding = fakeBinding(() => sseResponse(workersAITextStream()));
    const ai = createAI({ binding: asAi(binding) });
    await collectEvents(
      ai.streamSimple(
        ai(MODEL, { chatTemplateKwargs: { enable_thinking: false } }),
        userContext("hi"),
        { reasoning: "xhigh" }
      )
    );
    // Workers AI's own quirk table declares three levels, so `xhigh` collapses.
    expect(binding.calls[0]?.input.reasoning_effort).toBe("high");
    expect(binding.calls[0]?.input.chat_template_kwargs).toEqual({
      enable_thinking: false
    });
  });
});
