/**
 * Golden tests for the framework-neutral Workers AI ↔ OpenAI compat layer.
 * The fixtures are the shapes captured live from the run path (see the
 * conformance matrices); the expectations are strict OpenAI.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeChatCompletion,
  normalizeChatCompletionsStream,
  prepareChatCompletionsRequest,
  quirksFor,
  type StreamNormalizationOptions
} from "../../../models/core/chat-completions";
import { sseDataStream } from "../../../models/core/sse";

const GLM = "@cf/zai-org/glm-4.7-flash";
const KIMI = "@cf/moonshotai/kimi-k3";
const MISTRAL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
// A model with no override row: the strict OpenAI base profile.
const STRICT = "acme/strict-model";
const NEMOTRON = "@cf/nvidia/nemotron-3-120b-a12b";

/** Runs SSE `data:` payloads through the decoder and the normalizer. */
async function normalize(
  events: string[],
  modelId: string,
  options?: StreamNormalizationOptions
): Promise<unknown[]> {
  const body = events.map((event) => `data: ${event}\r\n\r\n`).join("");
  const stream = new Blob([body])
    .stream()
    .pipeThrough(sseDataStream())
    .pipeThrough(normalizeChatCompletionsStream(modelId, options));
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value === "[DONE]" ? value : JSON.parse(value));
  }
  return out;
}

function chunk(
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return JSON.stringify({
    choices: [{ delta, finish_reason: null, index: 0, logprobs: null }],
    created: 1,
    id: "chatcmpl-1",
    model: GLM,
    object: "chat.completion.chunk",
    p: "abdefgh",
    token_ids: null,
    usage: { completion_tokens: 1, prompt_tokens: 0, total_tokens: 1 },
    ...extra
  });
}

describe("core compat — quirks", () => {
  it("defaults to strict OpenAI for unknown ids", () => {
    expect(quirksFor("acme/new-model")).toMatchObject({
      imageUrls: "any",
      maxTokensField: "max_tokens",
      reasoningOff: "unsupported",
      reasoningReplay: "drop"
    });
    expect(quirksFor("@cf/acme/new-model")).toMatchObject({
      imageUrls: "data-only",
      reasoningOff: "chat-template",
      reasoningReplay: "reasoning_content"
    });
  });

  it("applies the longest matching override", () => {
    expect(quirksFor(GLM).toolChoiceRequired).toBe("named-fallback");
    expect(quirksFor("@cf/zai-org/glm-5.3").toolChoiceRequired).toBe(
      "supported"
    );
    expect(quirksFor(KIMI).reasoningOff).toBe("unsupported");
    expect(quirksFor(MISTRAL).jsonSchema).toBe("unsupported");
    expect(quirksFor(MISTRAL).toolCallIds).toBe("alnum-9");
    expect(quirksFor(STRICT).toolCallIds).toBe("any");
  });
});

describe("core compat — request preparation", () => {
  const tool = {
    function: { name: "getWeather", parameters: { type: "object" } },
    type: "function"
  };

  it("passes a strict body through untouched for a conformant Workers AI model", () => {
    const { body, warnings } = prepareChatCompletionsRequest(
      {
        max_tokens: 64,
        messages: [{ content: "hi", role: "user" }],
        seed: 42,
        stream: true,
        stream_options: { include_usage: true }
      },
      "@cf/zai-org/glm-5.3"
    );
    expect(body).toEqual({
      max_tokens: 64,
      messages: [{ content: "hi", role: "user" }],
      seed: 42,
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(warnings).toEqual([]);
  });

  it("turns a null effort into the vLLM chat-template switch on Workers AI", () => {
    const { body, warnings } = prepareChatCompletionsRequest(
      { messages: [], reasoning_effort: null },
      GLM
    );
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(warnings).toEqual([]);
  });

  it("reports whether the body turned reasoning off", () => {
    expect(
      prepareChatCompletionsRequest({ reasoning_effort: null }, GLM)
        .reasoningOff
    ).toBe(true);
    expect(
      prepareChatCompletionsRequest({ reasoning_effort: "low" }, GLM)
        .reasoningOff
    ).toBe(false);
    expect(
      prepareChatCompletionsRequest({ reasoning_effort: null }, KIMI)
        .reasoningOff
    ).toBe(false);
  });

  it("warns when a model cannot turn reasoning off", () => {
    for (const id of [KIMI, "@cf/openai/gpt-oss-120b", STRICT]) {
      const { body, warnings } = prepareChatCompletionsRequest(
        { messages: [], reasoning_effort: null },
        id
      );
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("chat_template_kwargs");
      expect(warnings.map((w) => w.feature)).toEqual(["reasoning-off"]);
    }
  });

  it("clamps the extended effort levels", () => {
    expect(
      prepareChatCompletionsRequest({ reasoning_effort: "xhigh" }, GLM).body
        .reasoning_effort
    ).toBe("high");
    expect(
      prepareChatCompletionsRequest({ reasoning_effort: "minimal" }, STRICT)
        .body.reasoning_effort
    ).toBe("low");
  });

  it("leaves the output-token cap as max_tokens", () => {
    expect(prepareChatCompletionsRequest({ max_tokens: 5 }, GLM).body).toEqual({
      max_tokens: 5
    });
    expect(
      prepareChatCompletionsRequest({ max_tokens: 5 }, STRICT).body
    ).toEqual({ max_tokens: 5 });
  });

  it("drops the OpenAI-only strict flag, and the format itself for Mistral", () => {
    const format = {
      json_schema: { name: "a", schema: { type: "object" }, strict: true },
      type: "json_schema"
    };
    expect(
      prepareChatCompletionsRequest({ response_format: format }, STRICT).body
        .response_format
    ).toEqual({
      json_schema: { name: "a", schema: { type: "object" } },
      type: "json_schema"
    });
    expect(
      prepareChatCompletionsRequest({ response_format: format }, GLM).body
        .response_format
    ).toEqual({
      json_schema: { name: "a", schema: { type: "object" } },
      type: "json_schema"
    });
    const mistral = prepareChatCompletionsRequest(
      {
        chat_template_kwargs: { enable_thinking: false },
        response_format: format
      },
      MISTRAL
    );
    expect(mistral.body).not.toHaveProperty("response_format");
    expect(mistral.body).not.toHaveProperty("chat_template_kwargs");
    expect(mistral.warnings.map((w) => w.feature)).toEqual([
      "chat-template-kwargs",
      "response-format"
    ]);
  });

  it("rewrites tool_choice required for glm-4.7-flash", () => {
    const one = prepareChatCompletionsRequest(
      { tool_choice: "required", tools: [tool] },
      GLM
    );
    expect(one.body.tool_choice).toEqual({
      function: { name: "getWeather" },
      type: "function"
    });
    const two = prepareChatCompletionsRequest(
      { tool_choice: "required", tools: [tool, tool] },
      GLM
    );
    expect(two.body).not.toHaveProperty("tool_choice");
    expect(two.warnings.map((w) => w.feature)).toEqual([
      "tool-choice-required"
    ]);
    expect(
      prepareChatCompletionsRequest(
        { tool_choice: "required", tools: [tool] },
        "@cf/zai-org/glm-5.3"
      ).body.tool_choice
    ).toBe("required");
  });

  it("drops image URLs for Workers AI and keeps data URLs", () => {
    const messages = [
      {
        content: [
          { text: "look", type: "text" },
          { image_url: { url: "https://x.test/a.png" }, type: "image_url" },
          {
            image_url: { url: "data:image/png;base64,AQID" },
            type: "image_url"
          }
        ],
        role: "user"
      }
    ];
    const cf = prepareChatCompletionsRequest({ messages }, GLM);
    expect((cf.body.messages as { content: unknown[] }[])[0].content).toEqual([
      { text: "look", type: "text" },
      { image_url: { url: "data:image/png;base64,AQID" }, type: "image_url" }
    ]);
    expect(cf.warnings.map((w) => w.feature)).toEqual(["image-url"]);
    const vendor = prepareChatCompletionsRequest({ messages }, STRICT);
    expect(vendor.body.messages).toEqual(messages);
  });

  it("keeps replayed reasoning on Workers AI and drops it elsewhere", () => {
    const messages = [
      { content: "hello", reasoning_content: "thinking", role: "assistant" }
    ];
    expect(
      prepareChatCompletionsRequest({ messages }, GLM).body.messages
    ).toEqual(messages);
    const vendor = prepareChatCompletionsRequest({ messages }, STRICT);
    expect(vendor.body.messages).toEqual([
      { content: "hello", role: "assistant" }
    ]);
    expect(vendor.warnings.map((w) => w.feature)).toEqual([
      "assistant-reasoning"
    ]);
  });

  it("bridges tool → user for Mistral and blanks null assistant content on Workers AI", () => {
    const messages = [
      { content: "hi", role: "user" },
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: "{}", name: "getWeather" },
            id: "call_1",
            type: "function"
          }
        ]
      },
      { content: "{}", role: "tool", tool_call_id: "call_1" },
      { content: "and?", role: "user" }
    ];
    const mistral = prepareChatCompletionsRequest({ messages }, MISTRAL);
    expect(
      (mistral.body.messages as { role: string }[]).map((m) => m.role)
    ).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    const cf = prepareChatCompletionsRequest({ messages }, GLM);
    expect((cf.body.messages as { content: unknown }[])[1].content).toBe("");
    expect((cf.body.messages as { role: string }[]).map((m) => m.role)).toEqual(
      ["user", "assistant", "tool", "user"]
    );
    // Only Mistral rewrites the id; everyone else replays it verbatim.
    expect(
      (cf.body.messages as { tool_call_id?: string }[])[2].tool_call_id
    ).toBe("call_1");
  });
});

/** The tool-call ids a prepared body ends up with, call side then result side. */
function toolCallIds(body: Record<string, unknown>): {
  calls: string[];
  results: string[];
} {
  const messages = (body.messages ?? []) as Record<string, unknown>[];
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        calls.push((call as { id: string }).id);
      }
    }
    if (typeof message.tool_call_id === "string") {
      results.push(message.tool_call_id);
    }
  }
  return { calls, results };
}

/** One assistant turn calling `count` tools, then their results. */
function toolRound(ids: string[]): Record<string, unknown>[] {
  return [
    { content: "hi", role: "user" },
    {
      content: null,
      role: "assistant",
      tool_calls: ids.map((id) => ({
        function: { arguments: "{}", name: "getWeather" },
        id,
        type: "function"
      }))
    },
    ...ids.map((id) => ({ content: "{}", role: "tool", tool_call_id: id }))
  ];
}

describe("core compat — Mistral tool-call ids", () => {
  // 40-matt-mistral-small-3.1-24b-instruct-J: "Tool call id was call_1 but
  // must be a-z, A-Z, 0-9, with a length of 9."
  it("rewrites both sides of a non-conformant id to the same 9-char value", () => {
    const { body, warnings } = prepareChatCompletionsRequest(
      { messages: toolRound(["call_1"]) },
      MISTRAL
    );
    const { calls, results } = toolCallIds(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^[0-9A-Za-z]{9}$/);
    expect(results).toEqual(calls);
    expect(warnings.map((w) => w.feature)).toEqual(["tool-call-id"]);
    expect(warnings[0].message).toContain("1 id was rewritten");
  });

  it("is deterministic across calls and distinct per original id", () => {
    const first = prepareChatCompletionsRequest(
      { messages: toolRound(["call_1", "call_2"]) },
      MISTRAL
    );
    const second = prepareChatCompletionsRequest(
      { messages: toolRound(["call_1", "call_2"]) },
      MISTRAL
    );
    const ids = toolCallIds(first.body).calls;
    expect(toolCallIds(second.body).calls).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
    expect(first.warnings[0].message).toContain("2 ids were rewritten");
  });

  it("leaves conformant ids alone and never collides with one", () => {
    const conformant = "abc123XYZ";
    const { body, warnings } = prepareChatCompletionsRequest(
      { messages: toolRound([conformant, "call_1"]) },
      MISTRAL
    );
    const { calls, results } = toolCallIds(body);
    expect(calls[0]).toBe(conformant);
    expect(calls[1]).not.toBe(conformant);
    expect(calls[1]).toMatch(/^[0-9A-Za-z]{9}$/);
    expect(results).toEqual(calls);
    expect(warnings[0].message).toContain("1 id was rewritten");
  });

  it("rewrites a tool result whose call turn is no longer in the window", () => {
    const { body } = prepareChatCompletionsRequest(
      {
        messages: [{ content: "{}", role: "tool", tool_call_id: "call_9" }]
      },
      MISTRAL
    );
    expect(toolCallIds(body).results[0]).toMatch(/^[0-9A-Za-z]{9}$/);
  });

  it("touches nothing, and warns about nothing, on every other model", () => {
    for (const id of [GLM, STRICT]) {
      const { body, warnings } = prepareChatCompletionsRequest(
        { messages: toolRound(["call_1"]) },
        id
      );
      expect(toolCallIds(body)).toEqual({
        calls: ["call_1"],
        results: ["call_1"]
      });
      expect(warnings.map((w) => w.feature)).not.toContain("tool-call-id");
    }
  });
});

describe("core compat — response normalization", () => {
  it("unifies the reasoning spelling and the echoed model id", () => {
    const body = normalizeChatCompletion(
      {
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "hi",
              reasoning: "because",
              reasoning_content: "because",
              role: "assistant"
            }
          }
        ],
        model: `${GEMMA}-external`
      },
      GEMMA
    );
    expect(body.model).toBe(GEMMA);
    const message = (body.choices as { message: Record<string, unknown> }[])[0]
      .message;
    expect(message).toEqual({
      content: "hi",
      reasoning_content: "because",
      role: "assistant"
    });
  });

  it("lifts the native Workers AI body into choices[0]", () => {
    const body = normalizeChatCompletion(
      {
        response: { answer: "42" },
        tool_calls: [{ arguments: { city: "London" }, name: "getWeather" }],
        usage: { completion_tokens: 2, prompt_tokens: 1 }
      },
      GLM
    );
    expect(body).toEqual({
      choices: [
        {
          finish_reason: "tool_calls",
          index: 0,
          message: {
            content: '{"answer":"42"}',
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: '{"city":"London"}',
                  name: "getWeather"
                },
                index: 0,
                type: "function"
              }
            ]
          }
        }
      ],
      model: undefined,
      usage: { completion_tokens: 2, prompt_tokens: 1 }
    });
  });

  it("infers a missing finish_reason", () => {
    const body = normalizeChatCompletion(
      { choices: [{ index: 0, message: { content: "x", role: "assistant" } }] },
      GLM
    );
    expect((body.choices as { finish_reason: string }[])[0].finish_reason).toBe(
      "stop"
    );
  });
});

describe("core compat — stream normalization", () => {
  it("turns the live Workers AI hybrid stream into strict OpenAI chunks", async () => {
    const out = await normalize(
      [
        chunk({ content: "", reasoning_content: null, role: "assistant" }),
        chunk({ reasoning: "Th", reasoning_content: "Th" }),
        chunk({ content: "Hi", reasoning_content: null }),
        chunk(
          { content: "", reasoning_content: null },
          {
            choices: [
              { delta: { content: "" }, finish_reason: "stop", index: 0 }
            ]
          }
        ),
        JSON.stringify({
          choices: [],
          id: "chatcmpl-1",
          usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }
        }),
        JSON.stringify({
          response: "",
          usage: { completion_tokens: 64, prompt_tokens: 11, total_tokens: 75 }
        }),
        "[DONE]"
      ],
      GLM
    );
    expect(out).toEqual([
      {
        choices: [
          {
            delta: { content: "", role: "assistant" },
            finish_reason: null,
            index: 0,
            logprobs: null
          }
        ],
        created: 1,
        id: "chatcmpl-1",
        model: GLM,
        object: "chat.completion.chunk"
      },
      {
        choices: [
          {
            delta: { reasoning_content: "Th" },
            finish_reason: null,
            index: 0,
            logprobs: null
          }
        ],
        created: 1,
        id: "chatcmpl-1",
        model: GLM,
        object: "chat.completion.chunk"
      },
      {
        choices: [
          {
            delta: { content: "Hi" },
            finish_reason: null,
            index: 0,
            logprobs: null
          }
        ],
        created: 1,
        id: "chatcmpl-1",
        model: GLM,
        object: "chat.completion.chunk"
      },
      {
        choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }],
        created: 1,
        id: "chatcmpl-1",
        model: GLM,
        object: "chat.completion.chunk"
      },
      {
        choices: [],
        created: 1,
        id: "chatcmpl-1",
        model: GLM,
        object: "chat.completion.chunk",
        usage: { completion_tokens: 64, prompt_tokens: 11, total_tokens: 75 }
      },
      "[DONE]"
    ]);
  });

  it("lifts native text deltas and tool calls, and synthesizes the finish reason", async () => {
    const out = await normalize(
      [
        JSON.stringify({ response: "Hel" }),
        JSON.stringify({ response: "lo" }),
        JSON.stringify({
          response: "",
          tool_calls: [{ arguments: { city: "London" }, name: "getWeather" }]
        }),
        JSON.stringify({
          response: "",
          usage: { completion_tokens: 3, prompt_tokens: 2 }
        }),
        "[DONE]"
      ],
      GLM
    );
    expect(out).toEqual([
      {
        choices: [{ delta: { content: "Hel" }, finish_reason: null, index: 0 }],
        object: "chat.completion.chunk"
      },
      {
        choices: [{ delta: { content: "lo" }, finish_reason: null, index: 0 }],
        object: "chat.completion.chunk"
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: {
                    arguments: '{"city":"London"}',
                    name: "getWeather"
                  },
                  index: 0,
                  type: "function"
                }
              ]
            },
            finish_reason: null,
            index: 0
          }
        ],
        object: "chat.completion.chunk"
      },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
        object: "chat.completion.chunk"
      },
      {
        choices: [],
        object: "chat.completion.chunk",
        usage: { completion_tokens: 3, prompt_tokens: 2 }
      },
      "[DONE]"
    ]);
  });

  it("leaves a strict OpenAI vendor stream alone, including its final usage chunk", async () => {
    const first = JSON.stringify({
      choices: [{ delta: { content: "Hi" }, finish_reason: null, index: 0 }],
      id: "x",
      model: "gemini-3-flash",
      object: "chat.completion.chunk",
      usage: null
    });
    const finish = JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      id: "x",
      model: "gemini-3-flash",
      object: "chat.completion.chunk",
      usage: null
    });
    const usage = JSON.stringify({
      choices: [],
      id: "x",
      model: "gemini-3-flash",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
    });
    const out = await normalize([first, finish, usage, "[DONE]"], STRICT);
    expect(out).toEqual([
      JSON.parse(first),
      JSON.parse(finish),
      JSON.parse(usage),
      "[DONE]"
    ]);
  });

  it("moves nemotron's mislabeled answer back into content when reasoning is off", async () => {
    // 41-matt-nemotron-3-120b-a12b-S_usage_s: with enable_thinking=false the
    // answer streams as `delta.reasoning`; the non-streaming body puts the
    // same text in `content`.
    const usage = { completion_tokens: 4, prompt_tokens: 9, total_tokens: 13 };
    const delta = (delta: Record<string, unknown>, finish: string | null) =>
      JSON.stringify({
        choices: [{ delta, finish_reason: finish, index: 0 }],
        created: 1,
        id: "chatcmpl-n",
        model: NEMOTRON,
        object: "chat.completion.chunk",
        usage
      });
    const events = [
      delta({ content: "", role: "assistant" }, null),
      delta({ reasoning: "Hi" }, null),
      delta({ reasoning: " there" }, null),
      delta({ reasoning: "!" }, null),
      delta({ reasoning: "" }, "stop"),
      JSON.stringify({ choices: [], id: "chatcmpl-n", usage }),
      JSON.stringify({ response: "", usage }),
      "[DONE]"
    ];
    const text = (chunks: unknown[], key: string) =>
      chunks
        .map((chunk) => {
          const choice = (
            chunk as { choices?: { delta?: Record<string, unknown> }[] }
          ).choices?.[0];
          const value = choice?.delta?.[key];
          return typeof value === "string" ? value : "";
        })
        .join("");

    const off = await normalize(events, NEMOTRON, { reasoningOff: true });
    expect(text(off, "content")).toBe("Hi there!");
    expect(text(off, "reasoning_content")).toBe("");
    expect(off.at(-1)).toBe("[DONE]");

    // With reasoning on, or on any other family, reasoning stays reasoning.
    const on = await normalize(events, NEMOTRON);
    expect(text(on, "content")).toBe("");
    expect(text(on, "reasoning_content")).toBe("Hi there!");
    const glm = await normalize(events, GLM, { reasoningOff: true });
    expect(text(glm, "reasoning_content")).toBe("Hi there!");
  });

  it("does not synthesize a finish reason for a truncated stream", async () => {
    const out = await normalize([chunk({ content: "Hi" })], GLM);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe("[DONE]");
  });

  it("passes an error chunk through and stops there", async () => {
    const out = await normalize(
      [
        chunk({ content: "Hi" }),
        JSON.stringify({ error: { message: "boom", type: "server_error" } }),
        "[DONE]"
      ],
      GLM
    );
    expect(
      out.map((e) => (typeof e === "string" ? e : Object.keys(e as object)[0]))
    ).toEqual(["choices", "error", "[DONE]"]);
  });
});
