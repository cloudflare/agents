import { generateText, Output, streamText } from "ai";
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

const MODEL = "@cf/zai-org/glm-4.7-flash";

/** The live non-streaming body: reasoning only, `content: null`. */
const reasoningOnlyBody = {
  choices: [
    {
      finish_reason: "length",
      index: 0,
      logprobs: null,
      message: {
        annotations: null,
        audio: null,
        content: null,
        function_call: null,
        reasoning: "The user wants three words.",
        reasoning_content: "The user wants three words.",
        refusal: null,
        role: "assistant",
        tool_calls: []
      },
      stop_reason: null,
      token_ids: null
    }
  ],
  created: 1788432932,
  id: "chatcmpl-b46c5e48cb49b9ea",
  model: MODEL,
  object: "chat.completion",
  service_tier: null,
  system_fingerprint: null,
  usage: {
    completion_tokens: 64,
    neurons: 2.3901,
    prompt_tokens: 11,
    prompt_tokens_details: { cached_tokens: 4 },
    total_tokens: 75
  }
};

/** The live tool-call body: narration text alongside the call. */
const toolCallBody = {
  choices: [
    {
      finish_reason: "tool_calls",
      index: 0,
      message: {
        content: "I'll check the weather in London for you.",
        reasoning: "Need the weather tool.",
        reasoning_content: "Need the weather tool.",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"city": "London"}',
              name: "getWeather"
            },
            id: "chatcmpl-tool-9bcb8212b3ff6496",
            type: "function"
          }
        ]
      },
      stop_reason: 154829
    }
  ],
  created: 1788432932,
  id: "chatcmpl-tools",
  model: MODEL,
  object: "chat.completion",
  usage: { completion_tokens: 76, prompt_tokens: 165, total_tokens: 241 }
};

const chunk = (choices: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    choices,
    created: 1788432944,
    id: "chatcmpl-976ebec0943daf97",
    model: MODEL,
    object: "chat.completion.chunk",
    p: "abdefghijklmnoprstuvxyz12345",
    ...extra
  });

describe("workers ai — non-streaming JSON", () => {
  it("maps the OpenAI-shaped body: reasoning, usage, finish reason", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(reasoningOnlyBody, {
        headers: {
          "cf-aig-cache-status": "MISS",
          "cf-aig-log-id": "01M1KEHQ1GVRTH8K0TVA9NSH1Q",
          "cf-aig-step": "0"
        }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());

    expect(result.content).toEqual([
      { text: "The user wants three words.", type: "reasoning" }
    ]);
    expect(result.finishReason).toEqual({ raw: "length", unified: "length" });
    expect(result.usage.inputTokens).toMatchObject({
      cacheRead: 4,
      noCache: 7,
      total: 11
    });
    expect(result.usage.outputTokens.total).toBe(64);
    expect(result.response?.id).toBe("chatcmpl-b46c5e48cb49b9ea");
    expect(result.response?.modelId).toBe(MODEL);
    expect(result.response?.timestamp?.getTime()).toBe(1788432932 * 1000);
    expect(result.providerMetadata?.cloudflare).toEqual({
      cacheStatus: "MISS",
      gateway: "default",
      logId: "01M1KEHQ1GVRTH8K0TVA9NSH1Q",
      model: MODEL,
      step: 0
    });
  });

  it("keeps narration text alongside a tool call", async () => {
    const binding = fakeBinding(() => jsonResponse(toolCallBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());

    expect(result.content.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "tool-call"
    ]);
    expect(result.content[2]).toEqual({
      input: '{"city": "London"}',
      toolCallId: "chatcmpl-tool-9bcb8212b3ff6496",
      toolName: "getWeather",
      type: "tool-call"
    });
    expect(result.finishReason.unified).toBe("tool-calls");
  });

  it("parses the native { response, tool_calls } shape", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        response: "Native answer.",
        tool_calls: [{ arguments: { city: "London" }, name: "getWeather" }],
        usage: { completion_tokens: 5, prompt_tokens: 3 }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());

    expect(result.content[0]).toEqual({
      text: "Native answer.",
      type: "text"
    });
    const call = result.content[1];
    expect(call.type).toBe("tool-call");
    if (call.type === "tool-call") {
      expect(call.toolName).toBe("getWeather");
      expect(JSON.parse(call.input)).toEqual({ city: "London" });
      expect(call.toolCallId).toMatch(/.+/);
    }
  });

  it("stringifies a native object response (structured output quirk)", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({ response: { answer: "Paris" } })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());
    expect(result.content).toEqual([
      { text: '{"answer":"Paris"}', type: "text" }
    ]);
  });
});

describe("workers ai — streaming", () => {
  it("handles the live stream: deltas, heartbeat, native tail, [DONE]", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk(
          [
            {
              delta: {
                content: "",
                reasoning_content: null,
                role: "assistant"
              },
              finish_reason: null,
              index: 0
            }
          ],
          { usage: { completion_tokens: 0, prompt_tokens: 11 } }
        ),
        chunk([
          { delta: { reasoning: "1", reasoning_content: "1" }, index: 0 }
        ]),
        chunk([
          { delta: { reasoning: ".", reasoning_content: "." }, index: 0 }
        ]),
        chunk([{ delta: { content: "Hi there" }, index: 0 }]),
        chunk([{ delta: { content: "!" }, finish_reason: "stop", index: 0 }]),
        chunk([], { usage: { completion_tokens: 0, prompt_tokens: 0 } }),
        JSON.stringify({
          response: "",
          usage: {
            completion_tokens: 64,
            prompt_tokens: 11,
            total_tokens: 75
          }
        }),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const types = parts.map((part) => part.type);

    expect(types[0]).toBe("stream-start");
    expect(types).toContain("response-metadata");
    expect(types).toContain("reasoning-start");
    expect(types).toContain("reasoning-end");
    expect(types.filter((type) => type === "reasoning-delta")).toHaveLength(2);
    expect(types.filter((type) => type === "text-delta")).toHaveLength(2);
    const finish = parts.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") {
      expect(finish.finishReason).toEqual({ raw: "stop", unified: "stop" });
      expect(finish.usage.outputTokens.total).toBe(64);
      expect(finish.providerMetadata?.cloudflare).toMatchObject({
        gateway: "default",
        model: MODEL
      });
    }
    // Reasoning must close before text opens.
    expect(types.indexOf("reasoning-end")).toBeLessThan(
      types.indexOf("text-start")
    );
  });

  it("accepts a tool call delivered as one complete delta (live shape)", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([
          {
            delta: {
              content: "",
              reasoning_content: null,
              tool_calls: [
                {
                  function: {
                    arguments: '{"city": "London"}',
                    name: "getWeather"
                  },
                  id: "chatcmpl-tool-8a8be1fee2f66115",
                  index: 0,
                  type: "function"
                }
              ]
            },
            finish_reason: null,
            index: 0
          }
        ]),
        chunk([
          { delta: { content: "" }, finish_reason: "tool_calls", index: 0 }
        ]),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const toolCall = parts.find((part) => part.type === "tool-call");

    expect(toolCall).toEqual({
      input: '{"city": "London"}',
      toolCallId: "chatcmpl-tool-8a8be1fee2f66115",
      toolName: "getWeather",
      type: "tool-call"
    });
    const finish = parts.at(-1);
    if (finish?.type === "finish") {
      expect(finish.finishReason.unified).toBe("tool-calls");
    }
  });

  it("accumulates argument fragments and honours the null finalization chunk", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([
          {
            delta: {
              tool_calls: [
                {
                  function: { name: "getWeather" },
                  id: "call-1",
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
              tool_calls: [{ function: { arguments: '{"city":' }, index: 0 }]
            },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [{ function: { arguments: '"London"}' }, index: 0 }]
            },
            index: 0
          }
        ]),
        chunk([
          {
            delta: {
              tool_calls: [{ function: { name: null }, id: null, type: null }]
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

    expect(types.filter((type) => type === "tool-input-delta")).toHaveLength(2);
    expect(parts.find((part) => part.type === "tool-call")).toEqual({
      input: '{"city":"London"}',
      toolCallId: "call-1",
      toolName: "getWeather",
      type: "tool-call"
    });
    // The finalization chunk closes the call before the stream ends.
    expect(types.indexOf("tool-call")).toBeLessThan(types.indexOf("finish"));
  });

  it("keeps native top-level tool calls with object arguments apart", async () => {
    // The native Workers AI shape puts a whole arguments object on each entry
    // and carries no `index`, so both calls would otherwise merge into one
    // with an empty input.
    const binding = fakeBinding(() =>
      sseResponse([
        JSON.stringify({
          response: "",
          tool_calls: [
            { arguments: { city: "London" }, name: "getWeather" },
            { arguments: { city: "Lisbon" }, name: "getWeather" }
          ]
        }),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const calls = parts.filter((part) => part.type === "tool-call");

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => (call as { input: string }).input)).toEqual([
      '{"city":"London"}',
      '{"city":"Lisbon"}'
    ]);
  });

  it("degrades to a one-shot stream when JSON comes back for a stream request", async () => {
    const binding = fakeBinding(() => jsonResponse(toolCallBody));
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const types = parts.map((part) => part.type);

    expect(field(binding.calls[0].input, "stream")).toBe(true);
    expect(types).toEqual([
      "stream-start",
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish"
    ]);
  });

  it("reports a truncated stream as an error finish reason", async () => {
    const binding = fakeBinding(() =>
      sseResponse([chunk([{ delta: { content: "half" }, index: 0 }])])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const finish = parts.at(-1);

    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") {
      expect(finish.finishReason).toEqual({
        raw: "stream-truncated",
        unified: "error"
      });
    }
  });
});

describe("workers ai — request body", () => {
  it("sends the OpenAI json_schema envelope without strict", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({ ...reasoningOnlyBody, choices: [] })
    );
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL).doGenerate(
      callOptions({
        responseFormat: {
          name: "answer",
          schema: {
            properties: { answer: { type: "string" } },
            type: "object"
          },
          type: "json"
        }
      })
    );
    const format = field(binding.calls[0].input, "response_format");
    expect(format).toEqual({
      json_schema: {
        name: "answer",
        schema: {
          properties: { answer: { type: "string" } },
          type: "object"
        }
      },
      type: "json_schema"
    });
  });

  it("maps the unified reasoning option and passes chat_template_kwargs", async () => {
    const binding = fakeBinding(() => jsonResponse({ response: "ok" }));
    const ai = createAI({
      binding: asAi(binding)
    });
    const model = ai(MODEL, { chatTemplateKwargs: { enable_thinking: false } });

    await model.doGenerate(callOptions({ reasoning: "minimal" }));
    expect(field(binding.calls[0].input, "reasoning_effort")).toBe("low");
    expect(field(binding.calls[0].input, "chat_template_kwargs")).toEqual({
      enable_thinking: false
    });

    await model.doGenerate(callOptions({ reasoning: "xhigh" }));
    expect(field(binding.calls[1].input, "reasoning_effort")).toBe("high");

    // "off" becomes the vLLM chat-template switch rather than a null effort.
    await model.doGenerate(callOptions({ reasoning: "none" }));
    expect(binding.calls[2].input).not.toHaveProperty("reasoning_effort");
    expect(field(binding.calls[2].input, "chat_template_kwargs")).toEqual({
      enable_thinking: false
    });

    await model.doGenerate(callOptions({ reasoning: "provider-default" }));
    expect(binding.calls[3].input).not.toHaveProperty("reasoning_effort");
  });

  it("keeps seed and the penalties, and warns only about topK", async () => {
    const binding = fakeBinding(() => jsonResponse({ response: "ok" }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(
      callOptions({ frequencyPenalty: 0.5, seed: 42, topK: 3 })
    );

    expect(field(binding.calls[0].input, "seed")).toBe(42);
    expect(field(binding.calls[0].input, "frequency_penalty")).toBe(0.5);
    expect(binding.calls[0].input).not.toHaveProperty("random_seed");
    expect(
      result.warnings.map((warning) =>
        warning.type === "unsupported" ? warning.feature : warning.type
      )
    ).toEqual(["topK"]);
  });

  it("replays assistant reasoning in its own field, not in content", async () => {
    const binding = fakeBinding(() => jsonResponse({ response: "ok" }));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL).doGenerate(
      callOptions({
        prompt: [
          { content: [{ text: "hi", type: "text" }], role: "user" },
          {
            content: [
              { text: "thinking", type: "reasoning" },
              { text: "hello", type: "text" }
            ],
            role: "assistant"
          },
          { content: [{ text: "again", type: "text" }], role: "user" }
        ]
      })
    );
    const messages = field(binding.calls[0].input, "messages") as Record<
      string,
      unknown
    >[];
    expect(messages[1]).toEqual({
      content: "hello",
      reasoning_content: "thinking",
      role: "assistant"
    });
  });

  it("drops image URLs for Workers AI with a warning and inlines bytes", async () => {
    const binding = fakeBinding(() => jsonResponse({ response: "ok" }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(
      callOptions({
        prompt: [
          {
            content: [
              { text: "look", type: "text" },
              {
                data: { type: "url", url: new URL("https://x.test/a.png") },
                mediaType: "image/png",
                type: "file"
              },
              {
                data: { data: new Uint8Array([1, 2, 3]), type: "data" },
                mediaType: "image/png",
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
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({
      image_url: { url: "data:image/png;base64,AQID" },
      type: "image_url"
    });
    expect(result.warnings[0]).toMatchObject({
      feature: "image-url",
      type: "unsupported"
    });
  });
});

describe("workers ai — tool results", () => {
  it("renders every tool-result output kind and warns about approvals", async () => {
    const binding = fakeBinding(() => jsonResponse({ response: "ok" }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(
      callOptions({
        prompt: [
          { content: [{ text: "go", type: "text" }], role: "user" },
          {
            content: [
              {
                output: { reason: "not allowed", type: "execution-denied" },
                toolCallId: "c1",
                toolName: "danger",
                type: "tool-result"
              },
              {
                output: {
                  type: "content",
                  value: [
                    { text: "one", type: "text" },
                    { text: "two", type: "text" }
                  ]
                },
                toolCallId: "c2",
                toolName: "notes",
                type: "tool-result"
              },
              {
                approvalId: "a1",
                approved: true,
                type: "tool-approval-response"
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

    expect(messages[1]).toMatchObject({
      content: "not allowed",
      tool_call_id: "c1"
    });
    expect(messages[2]).toMatchObject({
      content: "one\ntwo",
      tool_call_id: "c2"
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "tool-part" })
    );
  });
});

describe("workers ai — through the AI SDK", () => {
  it("generateText reads text, usage and provider metadata", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Hello there", role: "assistant" }
            }
          ],
          id: "chatcmpl-1",
          model: MODEL,
          usage: { completion_tokens: 2, prompt_tokens: 3 }
        },
        { headers: { "cf-aig-log-id": "log-123" } }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateText({ model: ai(MODEL), prompt: "hi" });

    expect(result.text).toBe("Hello there");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.outputTokens).toBe(2);
    expect(result.usage.inputTokens).toBe(3);
    expect(result.providerMetadata?.cloudflare).toMatchObject({
      logId: "log-123",
      model: MODEL
    });
  });

  it("streamText assembles the deltas", async () => {
    const binding = fakeBinding(() =>
      sseResponse([
        chunk([{ delta: { content: "Hello" }, index: 0 }]),
        chunk([
          { delta: { content: " world" }, finish_reason: "stop", index: 0 }
        ]),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = streamText({ model: ai(MODEL), prompt: "hi" });
    const chunks: string[] = [];
    for await (const part of result.textStream) chunks.push(part);

    expect(chunks.join("")).toBe("Hello world");
    expect(await result.finishReason).toBe("stop");
  });

  it("Output.object parses a JSON-mode answer", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"answer": "Paris"}', role: "assistant" }
          }
        ]
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateText({
      model: ai(MODEL),
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
      prompt: "capital of france"
    });

    expect(result.output).toEqual({ answer: "Paris" });
    expect(field(binding.calls[0].input, "response_format.type")).toBe(
      "json_schema"
    );
  });
});
