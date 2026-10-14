import { createProviderRegistry, generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { CloudflareAIError, createAI } from "../../../models/ai-sdk";
import {
  asAi,
  callOptions,
  collect,
  fakeBinding,
  jsonResponse,
  sseResponse
} from "./helpers";

const CLAUDE = "anthropic/claude-opus-4.8";
const GPT = "openai/gpt-5.5";
const WORKERS_AI = "@cf/zai-org/glm-4.7-flash";

/** `/run` answers a chat-completions request flat, in that shape. */
function chatBody(text: string, model = "claude-opus-4-8-20260101") {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: text, role: "assistant" }
      }
    ],
    created: 0,
    id: "chatcmpl-run",
    model,
    object: "chat.completion",
    usage: { completion_tokens: 5, prompt_tokens: 3, total_tokens: 8 }
  };
}

/** The AiError envelope `/run` answers a failure with. */
function runError(message: string, status: number): Response {
  return jsonResponse({ error: message }, { status });
}

describe("catalog models", () => {
  it("run on env.AI.run and ask /run for chat completions", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("Hi there")));
    const ai = createAI({ binding: asAi(binding), id: "prod", cacheTtl: 60 });
    const result = await ai(CLAUDE).doGenerate(callOptions());

    const call = binding.calls[0];
    expect(call.model).toBe(CLAUDE);
    expect(call.input).not.toHaveProperty("model");
    expect(call.options).toMatchObject({
      gateway: { cacheTtl: 60, id: "prod" },
      openaiEndpoint: "/v1/chat/completions",
      returnRawResponse: true
    });
    expect(result.content).toEqual([{ text: "Hi there", type: "text" }]);
    expect(result.usage.inputTokens.total).toBe(3);
    expect(result.usage.outputTokens.total).toBe(5);
  });

  it("leave a Workers AI request to Workers AI", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const ai = createAI({ binding: asAi(binding) });
    await ai(WORKERS_AI).doGenerate(callOptions());
    expect(binding.calls[0].options).not.toHaveProperty("openaiEndpoint");
  });

  it("name the format for a dynamic route too", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const ai = createAI({ binding: asAi(binding) });
    await ai("dynamic/support").doGenerate(callOptions());
    expect(binding.calls[0].options).toMatchObject({
      openaiEndpoint: "/v1/chat/completions"
    });
  });

  it("stream the chat-completions chunks /run sends", async () => {
    const chunk = (delta: Record<string, unknown>, finish?: string) =>
      JSON.stringify({
        choices: [
          { delta, index: 0, ...(finish ? { finish_reason: finish } : {}) }
        ],
        id: "chatcmpl-run",
        model: GPT,
        object: "chat.completion.chunk"
      });
    const binding = fakeBinding(() =>
      sseResponse([
        chunk({ content: "Hello", role: "assistant" }),
        chunk({ content: " there" }),
        chunk({}, "stop"),
        JSON.stringify({
          choices: [],
          id: "chatcmpl-run",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 }
        }),
        "[DONE]"
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = streamText({ model: ai(GPT), prompt: "hi" });
    expect(await result.text).toBe("Hello there");
    expect((await result.usage).outputTokens).toBe(2);
  });

  it("build the request as strict OpenAI, without the Workers AI knobs", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(CLAUDE, {
      chatTemplateKwargs: { enable_thinking: false },
      reasoningEffort: "high"
    }).doGenerate(callOptions());

    const input = binding.calls[0].input;
    expect(input.reasoning_effort).toBe("high");
    expect(input).not.toHaveProperty("chat_template_kwargs");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "chat-template-kwargs" })
    );
  });

  // TODO: a vendor header such as `anthropic-beta` set through `headers` on a
  // catalog model does not reach the vendor: aig-entry forwards only `cf-aig-*`
  // extra headers on `/run`. Turn this on once AI Gateway forwards it.
  it.todo(
    "pass a vendor header like anthropic-beta through /run to the vendor"
  );

  it("send the extra headers and the session affinity key", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const ai = createAI({ binding: asAi(binding) });
    await ai(CLAUDE, {
      headers: { "x-team": "agents" },
      sessionAffinity: "user-7"
    }).doGenerate(callOptions());
    expect(binding.calls[0].options.extraHeaders).toMatchObject({
      "x-session-affinity": "user-7",
      "x-team": "agents"
    });
  });

  it("work through generateText and a provider registry", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("Registered")));
    const registry = createProviderRegistry({
      cloudflare: createAI({ binding: asAi(binding) })
    });
    const { text } = await generateText({
      model: registry.languageModel(`cloudflare:${GPT}`),
      prompt: "hi"
    });
    expect(text).toBe("Registered");
    expect(binding.calls[0].model).toBe(GPT);
  });

  it("lift a /run failure into CloudflareAIError", async () => {
    const binding = fakeBinding(() =>
      runError("Model 'openai/gpt-0' not found", 404)
    );
    const ai = createAI({ binding: asAi(binding) });
    const caught = await ai("openai/gpt-0")
      .doGenerate(callOptions())
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(caught).toBeInstanceOf(CloudflareAIError);
    expect((caught as CloudflareAIError).status).toBe(404);
    expect((caught as CloudflareAIError).message).toMatch(/not found/);
  });
});

/** An Anthropic Messages stream, as `/run` sends a streamed Claude model. */
function anthropicSse(events: Record<string, unknown>[]): Response {
  const body = events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify({ p: "pad", ...event })}\n\n`
    )
    .join("");
  return new Response(body, {
    headers: { "cf-aig-run-id": "run-1", "content-type": "text/event-stream" },
    status: 200
  });
}

const MESSAGE_START = {
  message: {
    content: [],
    id: "msg_1",
    model: "claude-haiku-4-5-20251001",
    role: "assistant",
    type: "message",
    usage: { cache_read_input_tokens: 2, input_tokens: 16, output_tokens: 1 }
  },
  type: "message_start"
};

describe("streamed catalog models that answer in Anthropic events", () => {
  it("read as chat completions: text, finish reason and usage", async () => {
    const binding = fakeBinding(() =>
      anthropicSse([
        MESSAGE_START,
        {
          content_block: { text: "", type: "text" },
          index: 0,
          type: "content_block_start"
        },
        { type: "ping" },
        {
          delta: { text: "one, two", type: "text_delta" },
          index: 0,
          type: "content_block_delta"
        },
        {
          delta: { text: ", three", type: "text_delta" },
          index: 0,
          type: "content_block_delta"
        },
        { index: 0, type: "content_block_stop" },
        {
          delta: { stop_reason: "end_turn" },
          type: "message_delta",
          usage: { output_tokens: 7 }
        },
        { type: "message_stop" }
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = streamText({ model: ai(CLAUDE), prompt: "count" });

    expect(await result.text).toBe("one, two, three");
    expect(await result.finishReason).toBe("stop");
    const usage = await result.usage;
    expect(usage.inputTokens).toBe(18);
    expect(usage.outputTokens).toBe(7);
  });

  it("read tool calls and thinking", async () => {
    const binding = fakeBinding(() =>
      anthropicSse([
        MESSAGE_START,
        {
          content_block: { thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start"
        },
        {
          delta: { thinking: "Need the weather.", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta"
        },
        {
          delta: { signature: "sig", type: "signature_delta" },
          index: 0,
          type: "content_block_delta"
        },
        { index: 0, type: "content_block_stop" },
        {
          content_block: {
            id: "toolu_1",
            input: {},
            name: "getWeather",
            type: "tool_use"
          },
          index: 1,
          type: "content_block_start"
        },
        {
          delta: { partial_json: '{"city":', type: "input_json_delta" },
          index: 1,
          type: "content_block_delta"
        },
        {
          delta: { partial_json: ' "Lisbon"}', type: "input_json_delta" },
          index: 1,
          type: "content_block_delta"
        },
        { index: 1, type: "content_block_stop" },
        {
          delta: { stop_reason: "tool_use" },
          type: "message_delta",
          usage: { output_tokens: 20 }
        },
        { type: "message_stop" }
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const parts = await collect(
      (await ai(CLAUDE).doStream(callOptions())).stream
    );

    const reasoning = parts
      .filter((part) => part.type === "reasoning-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(reasoning).toBe("Need the weather.");
    expect(parts).toContainEqual(
      expect.objectContaining({
        input: '{"city": "Lisbon"}',
        toolCallId: "toolu_1",
        toolName: "getWeather",
        type: "tool-call"
      })
    );
    expect(parts.at(-1)).toMatchObject({
      finishReason: { unified: "tool-calls" },
      type: "finish"
    });
  });

  it("surface an error event as a stream error", async () => {
    const binding = fakeBinding(() =>
      anthropicSse([
        MESSAGE_START,
        {
          error: { message: "Overloaded", type: "overloaded_error" },
          type: "error"
        }
      ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const parts = await collect(
      (await ai(CLAUDE).doStream(callOptions())).stream
    );
    expect(parts).toContainEqual(expect.objectContaining({ type: "error" }));
  });
});

describe("a streamed catalog answer that drops", () => {
  it("resumes through the binding and delivers the whole answer", async () => {
    const chunk = (content: string) =>
      `data: ${JSON.stringify({
        choices: [{ delta: { content }, index: 0 }],
        id: "chatcmpl-run",
        model: GPT,
        object: "chat.completion.chunk"
      })}\n\n`;
    const events = [
      chunk("one"),
      chunk(", two"),
      chunk(", three"),
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
        id: "chatcmpl-run",
        object: "chat.completion.chunk"
      })}\n\n`,
      "data: [DONE]\n\n"
    ];
    const encoder = new TextEncoder();
    const resumed: string[] = [];
    const binding = {
      aiGatewayLogId: null,
      calls: [],
      async fetch(url: string) {
        resumed.push(url);
        const from = Number(new URL(url).searchParams.get("from"));
        return new Response(events.slice(from).join(""));
      },
      async run() {
        // Two events, then the connection drops.
        let pulled = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!pulled) {
              pulled = true;
              controller.enqueue(encoder.encode(events[0] + events[1]));
              return;
            }
            controller.error(new TypeError("Network connection lost."));
          }
        });
        return new Response(body, {
          headers: {
            "cf-aig-run-id": "run-9",
            "content-type": "text/event-stream"
          }
        });
      }
    };
    const ai = createAI({ binding: binding as unknown as Ai, id: "prod" });
    const result = streamText({ model: ai(GPT), prompt: "count" });

    expect(await result.text).toBe("one, two, three");
    expect(await result.finishReason).toBe("stop");
    expect(resumed).toEqual([
      "https://workers-binding.ai/ai-gateway/gateways/prod/run/run-9/resume?from=2"
    ]);
  });
});

describe("byokAlias", () => {
  it("reaches /run as cf-aig-byok-alias for a catalog model", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const ai = createAI({ binding: asAi(binding), byokAlias: "team-a" });
    await ai(CLAUDE).doGenerate(callOptions());

    const options = binding.calls[0].options;
    expect(options.extraHeaders).toMatchObject({
      "cf-aig-byok-alias": "team-a"
    });
    // The binding's own gateway options have no such field.
    expect(options.gateway).not.toHaveProperty("byokAlias");
  });

  it("stays off a Workers AI request, which has no vendor key", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const ai = createAI({ binding: asAi(binding), byokAlias: "team-a" });
    await ai(WORKERS_AI).doGenerate(callOptions());
    expect(binding.calls[0].options).not.toHaveProperty("extraHeaders");
  });
});

describe("model ids", () => {
  const ai = createAI({ binding: asAi(fakeBinding(() => jsonResponse({}))) });

  it("refuse a string that names no catalog model", () => {
    for (const id of ["gpt-5", "openai/", "/gpt-5", "@hf/thebloke/x"]) {
      expect(() => ai(id as never)).toThrow(
        /not a model id this provider knows/
      );
    }
  });

  it("refuse a catalog id on the modality methods", () => {
    expect(() =>
      ai.embedding("@cf/baai/bge-base-en-v1.5", {
        fallback: ["openai/text-embedding-3-small" as never]
      })
    ).toThrow(/not a Workers AI model id/);
  });

  it("refuse a bad id in a per-call fallback list before any request", async () => {
    const binding = fakeBinding(() => jsonResponse(chatBody("ok")));
    const scoped = createAI({ binding: asAi(binding) });
    await expect(
      scoped(CLAUDE).doGenerate(
        callOptions({
          providerOptions: { cloudflare: { fallback: ["gpt-5"] } }
        })
      )
    ).rejects.toThrow(/not a model id this provider knows/);
    expect(binding.calls).toHaveLength(0);
  });
});

describe("fallback", () => {
  const failing = (call: { model: string }) =>
    call.model === CLAUDE
      ? runError("Upstream unavailable", 503)
      : jsonResponse(chatBody(`from ${call.model}`));

  it("walks catalog and Workers AI legs in order", async () => {
    const binding = fakeBinding(failing);
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(CLAUDE, { fallback: [GPT, WORKERS_AI] }).doGenerate(
      callOptions()
    );
    expect(binding.calls.map((call) => call.model)).toEqual([CLAUDE, GPT]);
    expect(result.content).toEqual([{ text: `from ${GPT}`, type: "text" }]);
  });

  it("does not let a per-call fallback list re-expand on every leg", async () => {
    const binding = fakeBinding(() => runError("nope", 500));
    const ai = createAI({ binding: asAi(binding) });
    const caught = await ai(CLAUDE)
      .doGenerate(
        callOptions({ providerOptions: { cloudflare: { fallback: [GPT] } } })
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(binding.calls).toHaveLength(2);
    expect((caught as CloudflareAIError).attempts?.map((a) => a.model)).toEqual(
      [CLAUDE, GPT]
    );
  });

  it("keeps the rest of the per-call bag on a leg", async () => {
    const binding = fakeBinding(failing);
    const ai = createAI({ binding: asAi(binding) });
    await ai(CLAUDE, { fallback: [ai(WORKERS_AI)] }).doGenerate(
      callOptions({
        providerOptions: { cloudflare: { id: "per-call", skipCache: true } }
      })
    );
    expect(binding.calls[1].options.gateway).toMatchObject({
      id: "per-call",
      skipCache: true
    });
  });

  it("keeps a configured leg's own Workers AI knobs and headers", async () => {
    const binding = fakeBinding(failing);
    const ai = createAI({ binding: asAi(binding) });
    const leg = ai(WORKERS_AI, {
      chatTemplateKwargs: { enable_thinking: false },
      headers: { "x-leg": "yes" },
      reasoningEffort: "high"
    });
    await ai(CLAUDE, { cacheTtl: 30, fallback: [leg], id: "prod" }).doGenerate(
      callOptions()
    );

    const call = binding.calls[1];
    expect(call.input.reasoning_effort).toBe("high");
    expect(call.input.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(call.options.extraHeaders).toMatchObject({ "x-leg": "yes" });
    expect(call.options.gateway).toMatchObject({ cacheTtl: 30, id: "prod" });
  });

  it("sends the chain's gateway to a leg that named its own", async () => {
    const binding = fakeBinding(failing);
    const ai = createAI({ binding: asAi(binding) });
    const leg = ai(GPT, { cacheTtl: 0, id: "cheap" });
    await ai(CLAUDE, {
      cacheTtl: 60,
      fallback: [leg],
      id: "prod",
      metadata: { chain: "yes" }
    }).doGenerate(callOptions());

    expect(binding.calls[1].options.gateway).toMatchObject({
      cacheTtl: 60,
      id: "prod",
      metadata: { chain: "yes" }
    });
  });

  it("moves a leg's own fallback chain onto the outer chain's gateway", async () => {
    const binding = fakeBinding((call) =>
      call.model === WORKERS_AI
        ? jsonResponse(chatBody("ok"))
        : runError("nope", 503)
    );
    const ai = createAI({ binding: asAi(binding) });
    const inner = ai(GPT, { fallback: [WORKERS_AI], id: "old" });
    await ai(CLAUDE, { fallback: [inner], id: "new" }).doGenerate(
      callOptions()
    );
    expect(binding.calls.map((call) => call.model)).toEqual([
      CLAUDE,
      GPT,
      WORKERS_AI
    ]);
    for (const call of binding.calls) {
      expect(call.options.gateway).toMatchObject({ id: "new" });
    }
  });
});
