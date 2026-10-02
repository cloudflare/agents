import { generateText, isStepCount, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAI } from "../../../models/ai-sdk";
import {
  asAi,
  callOptions,
  collect,
  fakeBinding,
  field,
  jsonResponse,
  sseResponse
} from "./helpers";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// The chunk envelope captured live from OpenAI's chat completions (before
// `openai/*` moved to the Responses wire; every OpenAI-compatible vendor
// streams this shape): `usage` is present and null on every chunk but the
// last, and OpenAI pads each one with a random `obfuscation` string the
// parser has to ignore.
const chunk = (choices: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    choices,
    created: 1788439260,
    id: "chatcmpl-EK12S6COf1cd3VW6NHZy4uaPn8YHF",
    model: "gpt-5-mini-2025-08-07",
    object: "chat.completion.chunk",
    obfuscation: "JM9IA",
    service_tier: "default",
    system_fingerprint: null,
    usage: null,
    ...extra
  });

describe("chat completions wire — non-streaming", () => {
  it("maps content, cached tokens and reasoning tokens", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              annotations: [],
              content: "Hello.",
              refusal: null,
              role: "assistant"
            }
          }
        ],
        created: 1788439251,
        gatewayMetadata: { keySource: "Unified" },
        id: "chatcmpl-EK12JsfHJ8bj8ne1NZQZOIKYlWdjV",
        model: "gpt-5-mini-2025-08-07",
        object: "chat.completion",
        service_tier: "default",
        system_fingerprint: null,
        usage: {
          completion_tokens: 20,
          completion_tokens_details: {
            accepted_prediction_tokens: 0,
            audio_tokens: 0,
            reasoning_tokens: 12,
            rejected_prediction_tokens: 0
          },
          prompt_tokens: 30,
          prompt_tokens_details: { audio_tokens: 0, cached_tokens: 10 },
          total_tokens: 50
        }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());

    expect(result.content).toEqual([{ text: "Hello.", type: "text" }]);
    expect(result.usage.inputTokens).toEqual({
      cacheRead: 10,
      cacheWrite: undefined,
      noCache: 20,
      total: 30
    });
    expect(result.usage.outputTokens).toEqual({
      reasoning: 12,
      text: undefined,
      total: 20
    });
    expect(result.response?.modelId).toBe("gpt-5-mini-2025-08-07");
  });

  it("survives an empty answer when reasoning eats the budget (live gpt-5-mini capture)", async () => {
    // Captured live: with a small `max_completion_tokens`, gpt-5-mini spends
    // the whole budget on hidden reasoning and answers with empty content and
    // `finish_reason: "length"`. That must be a clean length finish, not a
    // parse failure or a bogus empty text part.
    const binding = fakeBinding(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "length",
            index: 0,
            message: {
              annotations: [],
              content: "",
              refusal: null,
              role: "assistant"
            }
          }
        ],
        created: 1788439251,
        gatewayMetadata: { keySource: "Unified" },
        id: "chatcmpl-EK12JsfHJ8bj8ne1NZQZOIKYlWdjV",
        model: "gpt-5-mini-2025-08-07",
        object: "chat.completion",
        usage: {
          completion_tokens: 64,
          completion_tokens_details: { reasoning_tokens: 64 },
          prompt_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0 },
          total_tokens: 76
        }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());

    expect(result.content).toEqual([]);
    expect(result.finishReason).toEqual({ raw: "length", unified: "length" });
    expect(result.usage.outputTokens.reasoning).toBe(64);
  });

  it("counts every prompt token as uncached when the vendor sends no cache detail", async () => {
    // Live `google/gemini-3-flash` answers on this wire without
    // `prompt_tokens_details` at all; the prompt total is still known, and
    // every one of those tokens was uncached.
    const binding = fakeBinding(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            logprobs: null,
            message: {
              content: "Hello there,",
              extra_content: { google: { thought_signature: "AY89a1" } },
              role: "assistant"
            }
          }
        ],
        created: 1788439303,
        gatewayMetadata: { keySource: "BYOK" },
        id: "B2uZatm8HuvS1PIPiP6Y2Ag",
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
    const result = await ai(
      "@cf/meta/llama-4-scout-17b-16e-instruct"
    ).doGenerate(callOptions());

    expect(result.content).toEqual([
      {
        providerMetadata: {
          cloudflare: {
            extraContent: { google: { thought_signature: "AY89a1" } }
          }
        },
        text: "Hello there,",
        type: "text"
      }
    ]);
    expect(result.usage.inputTokens).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: 6,
      total: 6
    });
    expect(result.usage.outputTokens.reasoning).toBe(57);
    // Google counts reasoning outside `completion_tokens` (6 + 3 + 57 = 66),
    // so the output total is derived from `total_tokens` rather than taken
    // from `completion_tokens` (3), which would lose 57 tokens.
    expect(result.usage.outputTokens.total).toBe(60);
    // The catalog resolves the short id to its `-preview` variant.
    expect(result.response?.modelId).toBe("google/gemini-3-flash-preview");
  });

  it("replays the Gemini thought signature on the next turn", async () => {
    // Gemini 3 rejects a function call replayed in the same turn without the
    // `extra_content.google.thought_signature` it was issued with.
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    await ai("@cf/meta/llama-4-scout-17b-16e-instruct").doGenerate(
      callOptions({
        prompt: [
          { content: [{ text: "weather?", type: "text" }], role: "user" },
          {
            content: [
              {
                providerOptions: {
                  cloudflare: {
                    extraContent: { google: { thought_signature: "msg-sig" } }
                  }
                },
                text: "checking",
                type: "text"
              },
              {
                input: '{"city":"Lisbon"}',
                providerOptions: {
                  cloudflare: {
                    toolExtraContent: {
                      google: { thought_signature: "tc-sig" }
                    }
                  }
                },
                toolCallId: "call_1",
                toolName: "getWeather",
                type: "tool-call"
              }
            ],
            role: "assistant"
          },
          {
            content: [
              {
                output: { type: "text", value: "sunny" },
                toolCallId: "call_1",
                toolName: "getWeather",
                type: "tool-result"
              }
            ],
            role: "tool"
          }
        ]
      })
    );

    const assistant = field(binding.calls[0].input, "messages.1");
    expect(field(assistant, "extra_content")).toEqual({
      google: { thought_signature: "msg-sig" }
    });
    expect(field(assistant, "tool_calls.0.extra_content")).toEqual({
      google: { thought_signature: "tc-sig" }
    });
  });

  it("maps content_filter and unknown finish reasons", async () => {
    const binding = fakeBinding((call) =>
      jsonResponse({
        choices: [
          {
            finish_reason: call.model === MODEL ? "content_filter" : "weird",
            message: { content: "", role: "assistant" }
          }
        ]
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const filtered = await ai(MODEL).doGenerate(callOptions());
    expect(filtered.finishReason).toEqual({
      raw: "content_filter",
      unified: "content-filter"
    });

    const other = await ai(
      "@cf/meta/llama-4-scout-17b-16e-instruct"
    ).doGenerate(callOptions());
    expect(other.finishReason).toEqual({ raw: "weird", unified: "other" });
  });
});

describe("chat completions wire — request body", () => {
  it("uses the OpenAI json_schema envelope, not the bare schema", async () => {
    // `strict` is OpenAI's own flag, and `openai/*` speaks the Responses wire;
    // the vendors on this wire get the plain envelope.
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL).doGenerate(
      callOptions({
        responseFormat: {
          name: "answer",
          schema: { properties: {}, type: "object" },
          type: "json"
        }
      })
    );
    expect(field(binding.calls[0].input, "response_format")).toEqual({
      json_schema: {
        name: "answer",
        schema: { properties: {}, type: "object" }
      },
      type: "json_schema"
    });
  });

  it("sends max_tokens to every model on this wire", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });

    await ai(MODEL).doGenerate(callOptions({ maxOutputTokens: 500 }));
    expect(field(binding.calls[0].input, "max_tokens")).toBe(500);
    expect(binding.calls[0].input).not.toHaveProperty("max_completion_tokens");

    await ai("@cf/zai-org/glm-4.7-flash").doGenerate(
      callOptions({ maxOutputTokens: 500 })
    );
    expect(field(binding.calls[1].input, "max_tokens")).toBe(500);
  });

  it("asks for usage on every stream", async () => {
    const binding = fakeBinding(() => sseResponse(["[DONE]"]));
    const ai = createAI({ binding: asAi(binding) });

    await ai(MODEL).doStream(callOptions());
    expect(field(binding.calls[0].input, "stream_options")).toEqual({
      include_usage: true
    });

    // Workers AI takes the option too; the compat layer folds its native
    // usage tail into the same final chunk.
    await ai("@cf/zai-org/glm-4.7-flash").doStream(callOptions());
    expect(field(binding.calls[1].input, "stream_options")).toEqual({
      include_usage: true
    });

    const plain = fakeBinding(() => jsonResponse({ choices: [] }));
    await createAI({ binding: asAi(plain) })(MODEL).doGenerate(callOptions());
    expect(plain.calls[0].input).not.toHaveProperty("stream_options");
  });

  it("warns about assistant parts it cannot replay", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(
      callOptions({
        prompt: [
          { content: [{ text: "hi", type: "text" }], role: "user" },
          {
            content: [
              { text: "thought", type: "reasoning" },
              {
                data: { data: "AQID", type: "data" },
                mediaType: "image/png",
                type: "file"
              }
            ],
            role: "assistant"
          }
        ]
      })
    );

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "assistant-part" })
    );
    // Workers AI replays assistant reasoning as `reasoning_content` rather
    // than dropping it, so only the file part is reported as lost.
    expect(field(binding.calls[0].input, "messages.1.reasoning_content")).toBe(
      "thought"
    );
  });

  it("turns reasoning off through the chat template", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    const explicit = await ai(MODEL, { reasoningEffort: null }).doGenerate(
      callOptions()
    );
    expect(binding.calls[0].input).not.toHaveProperty("reasoning_effort");
    // Workers AI's vLLM front end has a switch for it, so nothing is lost and
    // nothing is warned about.
    expect(field(binding.calls[0].input, "chat_template_kwargs")).toEqual({
      enable_thinking: false
    });
    expect(explicit.warnings).toEqual([]);

    const unified = await ai(MODEL).doGenerate(
      callOptions({ reasoning: "none" })
    );
    expect(binding.calls[1].input).not.toHaveProperty("reasoning_effort");
    expect(field(binding.calls[1].input, "chat_template_kwargs")).toEqual({
      enable_thinking: false
    });
    expect(unified.warnings).toEqual([]);
  });

  it("passes reasoning levels through, clamping the two this wire lacks", async () => {
    // `minimal` and `xhigh` are OpenAI's own levels; this wire takes
    // low | medium | high and answers 400 to anything else.
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    const model = ai(MODEL);

    await model.doGenerate(callOptions({ reasoning: "high" }));
    expect(field(binding.calls[0].input, "reasoning_effort")).toBe("high");

    await model.doGenerate(callOptions({ reasoning: "minimal" }));
    expect(field(binding.calls[1].input, "reasoning_effort")).toBe("low");

    await model.doGenerate(callOptions({ reasoning: "xhigh" }));
    expect(field(binding.calls[2].input, "reasoning_effort")).toBe("high");

    await model.doGenerate(callOptions({ reasoning: "medium" }));
    expect(field(binding.calls[3].input, "reasoning_effort")).toBe("medium");
  });

  it("keeps seed, the penalties and chatTemplateKwargs", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL, {
      chatTemplateKwargs: { enable_thinking: false }
    }).doGenerate(
      callOptions({ frequencyPenalty: 0.4, presencePenalty: 0.2, seed: 7 })
    );

    expect(field(binding.calls[0].input, "seed")).toBe(7);
    expect(field(binding.calls[0].input, "frequency_penalty")).toBe(0.4);
    expect(field(binding.calls[0].input, "presence_penalty")).toBe(0.2);
    // Workers AI's vLLM front end takes `chat_template_kwargs` verbatim.
    expect(field(binding.calls[0].input, "chat_template_kwargs")).toEqual({
      enable_thinking: false
    });
    expect(result.warnings).toEqual([]);
  });

  it("maps every tool choice form", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    const tools = [
      {
        description: "weather",
        inputSchema: { properties: {}, type: "object" as const },
        name: "getWeather",
        type: "function" as const
      }
    ];
    const model = ai(MODEL);

    await model.doGenerate(
      callOptions({ toolChoice: { type: "required" }, tools })
    );
    expect(field(binding.calls[0].input, "tool_choice")).toBe("required");

    await model.doGenerate(
      callOptions({
        toolChoice: { toolName: "getWeather", type: "tool" },
        tools
      })
    );
    expect(field(binding.calls[1].input, "tool_choice")).toEqual({
      function: { name: "getWeather" },
      type: "function"
    });
    expect((field(binding.calls[1].input, "tools") as unknown[]).length).toBe(
      1
    );

    await model.doGenerate(
      callOptions({ toolChoice: { type: "none" }, tools })
    );
    expect(field(binding.calls[2].input, "tool_choice")).toBe("none");
  });

  it("inlines image bytes and drops other files with a warning", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(
      callOptions({
        prompt: [
          {
            content: [
              { text: "look", type: "text" },
              {
                data: { data: "AQID", type: "data" },
                mediaType: "image/png",
                type: "file"
              },
              {
                data: { data: "AQID", type: "data" },
                mediaType: "application/pdf",
                type: "file"
              }
            ],
            role: "user"
          }
        ]
      })
    );
    const messages = field(binding.calls[0].input, "messages") as Record<
      string,
      unknown
    >[];
    const content = messages[0].content as Record<string, unknown>[];
    expect(content).toEqual([
      { text: "look", type: "text" },
      { image_url: { url: "data:image/png;base64,AQID" }, type: "image_url" }
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "file-part" })
    );
  });

  it("converts tool results into tool messages", async () => {
    const binding = fakeBinding(() => jsonResponse({ choices: [] }));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL).doGenerate(
      callOptions({
        prompt: [
          { content: [{ text: "weather?", type: "text" }], role: "user" },
          {
            content: [
              {
                input: { city: "London" },
                toolCallId: "call-1",
                toolName: "getWeather",
                type: "tool-call"
              }
            ],
            role: "assistant"
          },
          {
            content: [
              {
                output: { type: "json", value: { temp: 12 } },
                toolCallId: "call-1",
                toolName: "getWeather",
                type: "tool-result"
              }
            ],
            role: "tool"
          }
        ]
      })
    );
    const messages = field(binding.calls[0].input, "messages") as Record<
      string,
      unknown
    >[];
    expect(messages[1]).toEqual({
      content: "",
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"city":"London"}', name: "getWeather" },
          id: "call-1",
          type: "function"
        }
      ]
    });
    expect(messages[2]).toEqual({
      content: '{"temp":12}',
      name: "getWeather",
      role: "tool",
      tool_call_id: "call-1"
    });
  });
});

describe("chat completions wire — streaming", () => {
  it("streams text deltas and stops at [DONE]", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([{ delta: { role: "assistant" }, index: 0 }]),
        chunk([{ delta: { content: "Hel" }, index: 0 }]),
        chunk([{ delta: { content: "lo" }, index: 0 }]),
        chunk([{ delta: {}, finish_reason: "stop", index: 0 }]),
        chunk([], { usage: { completion_tokens: 2, prompt_tokens: 5 } }),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);

    const deltas = parts.filter((part) => part.type === "text-delta");
    expect(deltas.map((part) => part.delta).join("")).toBe("Hello");
    const finish = parts.at(-1);
    if (finish?.type === "finish") {
      expect(finish.finishReason).toEqual({ raw: "stop", unified: "stop" });
      expect(finish.usage.outputTokens.total).toBe(2);
    }
    const metadata = parts.find((part) => part.type === "response-metadata");
    expect(metadata).toMatchObject({
      id: "chatcmpl-EK12S6COf1cd3VW6NHZy4uaPn8YHF",
      modelId: "gpt-5-mini-2025-08-07"
    });
  });

  it("streams incremental tool-call arguments", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: "", name: "getWeather" },
                  id: "call_abc",
                  index: 0,
                  type: "function"
                }
              ]
            },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [{ function: { arguments: '{"ci' }, index: 0 }]
            },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [
                { function: { arguments: 'ty":"London"}' }, index: 0 }
              ]
            },
            index: 0
          }
        ]),
        chunk([{ delta: {}, finish_reason: "tool_calls", index: 0 }]),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);

    expect(parts.find((part) => part.type === "tool-input-start")).toEqual({
      id: "call_abc",
      toolName: "getWeather",
      type: "tool-input-start"
    });
    expect(parts.find((part) => part.type === "tool-call")).toEqual({
      input: '{"city":"London"}',
      toolCallId: "call_abc",
      toolName: "getWeather",
      type: "tool-call"
    });
  });

  it("closes a previous tool call when a new index opens", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: "{}", name: "a" },
                  id: "call_a",
                  index: 0,
                  type: "function"
                }
              ]
            },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: "{}", name: "b" },
                  id: "call_b",
                  index: 1,
                  type: "function"
                }
              ]
            },
            index: 0
          }
        ]),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const calls = parts.filter((part) => part.type === "tool-call");

    expect(calls).toHaveLength(2);
    expect(calls.map((part) => part.toolName)).toEqual(["a", "b"]);
    const types = parts.map((part) => part.type);
    // The first call closes before the second opens.
    expect(types.indexOf("tool-call")).toBeLessThan(
      types.lastIndexOf("tool-input-start")
    );
  });

  it("reads usage from the trailing empty-choices chunk", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([{ delta: { content: "hi" }, index: 0 }]),
        chunk([{ delta: {}, finish_reason: "stop", index: 0 }]),
        // Live shape: the usage tail is a chunk with an empty `choices` array.
        chunk([], {
          obfuscation: "eLucA",
          usage: {
            completion_tokens: 7,
            completion_tokens_details: {
              accepted_prediction_tokens: 0,
              audio_tokens: 0,
              reasoning_tokens: 0,
              rejected_prediction_tokens: 0
            },
            prompt_tokens: 11,
            prompt_tokens_details: { audio_tokens: 0, cached_tokens: 4 },
            total_tokens: 18
          }
        }),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const finish = parts.at(-1);

    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") {
      expect(finish.usage.inputTokens).toEqual({
        cacheRead: 4,
        cacheWrite: undefined,
        noCache: 7,
        total: 11
      });
      expect(finish.usage.outputTokens.total).toBe(7);
      expect(finish.finishReason).toEqual({ raw: "stop", unified: "stop" });
    }
  });

  it("does not mistake an empty argument fragment for the finalization chunk", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([
          {
            delta: {
              tool_calls: [
                {
                  function: { arguments: "", name: "getWeather" },
                  id: "call_x",
                  index: 0,
                  type: "function"
                }
              ]
            },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [{ function: { arguments: '{"a":' }, index: 0 }]
            },
            index: 0
          }
        ]),
        // Some vLLM tool parsers emit an empty fragment mid-stream.
        chunk([
          {
            delta: { tool_calls: [{ function: { arguments: "" }, index: 0 }] },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [{ function: { arguments: "1}" }, index: 0 }]
            },
            index: 0
          }
        ]),
        chunk([{ delta: {}, finish_reason: "tool_calls", index: 0 }]),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const types = parts.map((part) => part.type);

    expect(parts.filter((part) => part.type === "tool-call")).toEqual([
      {
        input: '{"a":1}',
        toolCallId: "call_x",
        toolName: "getWeather",
        type: "tool-call"
      }
    ]);
    // Nothing may follow the end of the tool input.
    expect(types.lastIndexOf("tool-input-delta")).toBeLessThan(
      types.indexOf("tool-input-end")
    );
  });

  it("surfaces a mid-stream error chunk", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([{ delta: { content: "partial" }, index: 0 }]),
        JSON.stringify({
          error: {
            message: "The server had an error",
            type: "server_error"
          }
        }),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);

    expect(parts.find((part) => part.type === "error")).toEqual({
      error: { message: "The server had an error", type: "server_error" },
      type: "error"
    });
    const finish = parts.at(-1);
    if (finish?.type === "finish") {
      expect(finish.finishReason).toEqual({
        raw: "server_error",
        unified: "error"
      });
    }
  });

  it("survives a malformed SSE event", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        "{not json",
        chunk([{ delta: { content: "ok" }, finish_reason: "stop", index: 0 }]),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("ok");
  });
});

describe("chat completions wire — through the AI SDK", () => {
  it("runs a tool loop across two steps", async () => {
    const binding = fakeBinding((call, index) =>
      index === 0
        ? jsonResponse({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"city":"London"}',
                        name: "getWeather"
                      },
                      id: "call_1",
                      type: "function"
                    }
                  ]
                }
              }
            ]
          })
        : jsonResponse({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "It is 12C in London.", role: "assistant" }
              }
            ]
          })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateText({
      model: ai(MODEL),
      prompt: "weather in London?",
      stopWhen: isStepCount(3),
      tools: {
        getWeather: tool({
          description: "Get the weather",
          execute: async ({ city }: { city: string }) => `12C in ${city}`,
          inputSchema: z.object({ city: z.string() })
        })
      }
    });

    expect(result.steps).toHaveLength(2);
    expect(result.toolCalls[0]?.toolName).toBe("getWeather");
    expect(result.toolResults[0]?.output).toBe("12C in London");
    expect(result.text).toBe("It is 12C in London.");
    // The second request replays the tool result as a tool message.
    const second = field(binding.calls[1].input, "messages") as Record<
      string,
      unknown
    >[];
    expect(second.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_1"
    });
  });

  it("streamText surfaces a streamed tool call", async () => {
    const binding = fakeBinding((_call, index) =>
      index === 0
        ? sseResponse([
            chunk([
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"city":"London"}',
                        name: "getWeather"
                      },
                      id: "call_1",
                      index: 0,
                      type: "function"
                    }
                  ]
                },
                index: 0
              }
            ]),
            chunk([{ delta: {}, finish_reason: "tool_calls", index: 0 }]),
            "[DONE]"
          ])
        : sseResponse([
            chunk([{ delta: { content: "done" }, index: 0 }]),
            chunk([{ delta: {}, finish_reason: "stop", index: 0 }]),
            "[DONE]"
          ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = streamText({
      model: ai(MODEL),
      prompt: "weather?",
      stopWhen: isStepCount(3),
      tools: {
        getWeather: tool({
          execute: async ({ city }: { city: string }) => `12C in ${city}`,
          inputSchema: z.object({ city: z.string() })
        })
      }
    });
    const text: string[] = [];
    for await (const part of result.textStream) text.push(part);

    expect(text.join("")).toBe("done");
    expect((await result.toolCalls)[0]?.toolName).toBe("getWeather");
  });
});
