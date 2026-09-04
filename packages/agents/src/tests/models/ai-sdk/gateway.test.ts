import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV4,
  SharedV4ProviderOptions
} from "@ai-sdk/provider";
import { generateImage, generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { CloudflareAIError, createAI } from "../../../models/ai-sdk";
import {
  asAi,
  callOptions,
  collect,
  fakeGatewayBinding,
  field,
  gatewayHeaders,
  jsonResponse,
  rawSseResponse
} from "./helpers";

const WORKERS_AI = "@cf/zai-org/glm-4.7-flash";

/**
 * The vendor providers are the user's, not ours: the key is a placeholder,
 * because unified billing means the gateway holds the real one.
 */
const anthropic = createAnthropic({ apiKey: "cloudflare" });
const openai = createOpenAI({ apiKey: "cloudflare" });

/** `research/43-demos-anthropic.json` — a live universal-gateway answer. */
const ANTHROPIC_BODY = `{"model":"claude-opus-4-8","id":"msg_011CegnLJN6J5fF354oKGjfj","type":"message","role":"assistant","content":[{"type":"text","text":"Hi there! How can I"}],"stop_reason":"max_tokens","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":8,"output_tokens_details":{"thinking_tokens":0},"service_tier":"standard","inference_geo":"global"}}`;

/** `research/43-demos-anthropic-stream.json`, padding field and all. */
const ANTHROPIC_STREAM = `event: message_start
data: {"p": "f002a9", "type":"message_start","message":{"model":"claude-opus-4-8","id":"msg_011CegnLPo2JNAH3vqGgjz33","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":7,"service_tier":"standard","inference_geo":"global"}}     }

event: content_block_start
data: {"p": "7190f9a9a7262d", "type":"content_block_start","index":0,"content_block":{"type":"text","text":""} }

event: ping
data: {"p": "c9c5d30a0fa352", "type": "ping"}

event: content_block_delta
data: {"p": "8ef6203", "type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there! How can"}  }

event: content_block_delta
data: {"p": "58dfd870bd0", "type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" I"} }

event: content_block_stop
data: {"p": "87ada6a425535", "type":"content_block_stop","index":0              }

event: message_delta
data: {"p": "dcd8558be3", "type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":8,"output_tokens_details":{"thinking_tokens":0}}            }

event: message_stop
data: {"p": "cd91742bd6798e9b", "type":"message_stop"            }

`;

/** `research/43-demos-openai-responses.json`, with the reasoning blob cut. */
const OPENAI_RESPONSES_BODY = `{
  "id": "resp_0c0436a31efbe59c016a999937517c87d0a100d84d30bc5074",
  "object": "response",
  "created_at": 1788451127,
  "status": "incomplete",
  "background": false,
  "billing": {
    "payer": "developer"
  },
  "completed_at": null,
  "error": null,
  "frequency_penalty": 0.0,
  "incomplete_details": {
    "reason": "max_output_tokens"
  },
  "instructions": null,
  "max_output_tokens": 16,
  "max_tool_calls": null,
  "model": "gpt-5-mini-2025-08-07",
  "moderation": null,
  "output": [
    {
      "id": "rs_0c0436a31efbe59c016a999937d85487d08bdea8cc82182757",
      "type": "reasoning",
      "content": [],
      "encrypted_content": "gAAAAABqmZk39OVdu6yYppF96zGfY7YYjfArPyRl4-raivV2\u2026truncated\u2026",
      "summary": []
    }
  ],
  "parallel_tool_calls": true,
  "presence_penalty": 0.0,
  "previous_response_id": null,
  "prompt_cache_key": null,
  "prompt_cache_retention": "in_memory",
  "reasoning": {
    "context": "current_turn",
    "effort": "medium",
    "mode": "standard",
    "summary": null
  },
  "safety_identifier": null,
  "service_tier": "default",
  "store": false,
  "temperature": 1.0,
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tool_usage": {
    "image_gen": {
      "input_tokens": 0,
      "input_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "output_tokens": 0,
      "output_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "total_tokens": 0
    },
    "web_search": {
      "num_requests": 0
    }
  },
  "tools": [],
  "top_logprobs": 0,
  "top_p": 1.0,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 7,
    "input_tokens_details": {
      "cache_write_tokens": 0,
      "cached_tokens": 0
    },
    "output_tokens": 0,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 7
  },
  "user": null,
  "metadata": {}
}`;

/** The Workers AI answer a fallback leg gives. */
const workersAIBody = {
  choices: [
    {
      finish_reason: "stop",
      message: { content: "from @cf", role: "assistant" }
    }
  ]
};

/** The gateway's own error envelope, captured shape (402, unified billing). */
const gatewayError = {
  description: "Invalid User Credentials",
  error: [
    {
      code: 2021,
      message: "Insufficient balance; add money to your gateway or use BYOK"
    }
  ],
  httpCode: 402,
  internalCode: 2021,
  message: "Insufficient balance; add money to your gateway or use BYOK",
  messages: [],
  name: "AiGatewayError",
  result: [],
  success: false
};

function anthropicResponse(): Response {
  return new Response(ANTHROPIC_BODY, {
    headers: { "content-type": "application/json", ...gatewayHeaders() },
    status: 200
  });
}

describe("universal gateway request", () => {
  it("routes an Anthropic model by host and keeps its body verbatim", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(anthropic("claude-opus-4-8")).doGenerate(
      callOptions({ maxOutputTokens: 8 })
    );

    const call = binding.universal[0];
    expect(call.provider).toBe("anthropic");
    expect(call.endpoint).toBe("v1/messages");
    expect(call.gatewayId).toBe("default");
    // The vendor's own id spelling reaches the gateway untouched: the live
    // capture shows `claude-opus-4.8` answering 404 "Did you mean …-4-8?".
    expect(call.query.model).toBe("claude-opus-4-8");
    expect(call.query.max_tokens).toBe(8);
    // The vendor's protocol headers travel; its credential does not.
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers).not.toHaveProperty("x-api-key");
    expect(call.headers).not.toHaveProperty("authorization");
    expect(call.headers).not.toHaveProperty("content-length");
    // The vendor's own parser read the vendor's own body.
    expect(result.content).toEqual([
      { text: "Hi there! How can I", type: "text" }
    ]);
    expect(result.finishReason.unified).toBe("length");
  });

  it("routes an OpenAI Responses model to the responses endpoint", async () => {
    const binding = fakeGatewayBinding({
      universal: () =>
        new Response(OPENAI_RESPONSES_BODY, {
          headers: { "content-type": "application/json", ...gatewayHeaders() },
          status: 200
        })
    });
    const ai = createAI({ binding: asAi(binding) });
    const model = ai(openai.responses("gpt-5-mini"));
    expect(model.modelId).toBe("gpt-5-mini");
    expect(model.provider).toBe("openai.responses");

    const result = await model.doGenerate(callOptions());
    const call = binding.universal[0];
    expect(call.provider).toBe("openai");
    expect(call.endpoint).toBe("v1/responses");
    expect(call.query.model).toBe("gpt-5-mini");
    expect(call.headers).not.toHaveProperty("authorization");
    expect(result.usage.inputTokens.total).toBe(7);
    expect(result.response?.modelId).toBe("gpt-5-mini-2025-08-07");
  });

  it("never touches the caller's model object", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    const model = anthropic("claude-opus-4-8");
    const before = (model as unknown as { config: { fetch?: unknown } }).config;
    const beforeFetch = before.fetch;

    await ai(model).doGenerate(callOptions());

    const after = (model as unknown as { config: { fetch?: unknown } }).config;
    expect(after).toBe(before);
    expect(after.fetch).toBe(beforeFetch);
  });
});

describe("gateway options", () => {
  it("merges provider, model and per-call layers in that order", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({
      binding: asAi(binding),
      cacheTtl: 60,
      collectLog: true,
      id: "prod",
      metadata: { app: "next-models" }
    });

    await ai(anthropic("claude-opus-4-8"), {
      cacheTtl: 30,
      metadata: { route: "chat" }
    }).doGenerate(
      callOptions({
        providerOptions: {
          cloudflare: { cacheTtl: 5, skipCache: false }
        }
      })
    );

    const call = binding.universal[0];
    expect(call.gatewayId).toBe("prod");
    expect(call.options.gateway).toMatchObject({
      cacheTtl: 5,
      collectLog: true,
      id: "prod",
      metadata: { app: "next-models", route: "chat" },
      skipCache: false
    });
  });

  it("reads providerOptions.cloudflare and hides it from the vendor", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    await ai(anthropic("claude-opus-4-8")).doGenerate(
      callOptions({
        providerOptions: {
          anthropic: { sendReasoning: false },
          cloudflare: { id: "per-call", skipCache: true }
        }
      })
    );

    const call = binding.universal[0];
    expect(call.gatewayId).toBe("per-call");
    expect(call.options.gateway).toMatchObject({ skipCache: true });
    // Ours is read and removed; the vendor's own key is left alone.
    expect(call.query).not.toHaveProperty("cloudflare");
  });

  it("warns that the Workers AI knobs do not reach a vendor model", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(anthropic("claude-opus-4-8"), {
      chatTemplateKwargs: { enable_thinking: false },
      reasoningEffort: "high"
    }).doGenerate(callOptions());

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "reasoningEffort" })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "chatTemplateKwargs" })
    );
    // Nothing of ours reaches the vendor's body.
    expect(binding.universal[0].query).not.toHaveProperty("reasoning_effort");
    expect(binding.universal[0].query).not.toHaveProperty(
      "chat_template_kwargs"
    );
  });

  it("sends the extra headers and the session affinity key", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    await ai(anthropic("claude-opus-4-8"), {
      headers: { "x-team": "agents" },
      sessionAffinity: "user-7"
    }).doGenerate(callOptions());

    expect(binding.universal[0].options.extraHeaders).toEqual({
      "x-session-affinity": "user-7",
      "x-team": "agents"
    });
  });
});

describe("provider metadata", () => {
  it("adds cloudflare metadata to a generation without losing the vendor's", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding), id: "prod" });
    const result = await ai(anthropic("claude-opus-4-8")).doGenerate(
      callOptions()
    );

    expect(result.providerMetadata?.cloudflare).toMatchObject({
      cacheStatus: "MISS",
      eventId: "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
      gateway: "prod",
      logId: "01M1KZWN069WWNPC18V05NKHSS",
      model: "claude-opus-4-8",
      provider: "anthropic",
      requestId: "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
      step: 0,
      traceId: "2babd9bbb1984dfc90417e513c60a714"
    });
    // Anthropic's own block is still there.
    expect(result.providerMetadata?.anthropic).toBeDefined();
    expect(result.response?.headers?.["cf-aig-log-id"]).toBe(
      "01M1KZWN069WWNPC18V05NKHSS"
    );
  });

  it("stamps the finish part of a stream", async () => {
    const binding = fakeGatewayBinding({
      universal: () =>
        rawSseResponse(ANTHROPIC_STREAM, { headers: gatewayHeaders() })
    });
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(anthropic("claude-opus-4-8")).doStream(
      callOptions()
    );
    const parts = await collect(stream);

    expect(binding.universal[0].query.stream).toBe(true);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("Hi there! How can I");
    const finish = parts.find((part) => part.type === "finish");
    expect(
      finish?.type === "finish" && finish.providerMetadata?.cloudflare
    ).toMatchObject({
      logId: "01M1KZWN069WWNPC18V05NKHSS",
      model: "claude-opus-4-8",
      provider: "anthropic"
    });
  });
});

describe("through the AI SDK", () => {
  it("generateText reads a routed vendor answer", async () => {
    const binding = fakeGatewayBinding({
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateText({
      model: ai(anthropic("claude-opus-4-8")),
      prompt: "hi"
    });
    expect(result.text).toBe("Hi there! How can I");
  });

  it("streamText reads the vendor's own SSE through the gateway", async () => {
    const binding = fakeGatewayBinding({
      universal: () =>
        rawSseResponse(ANTHROPIC_STREAM, { headers: gatewayHeaders() })
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = streamText({
      model: ai(anthropic("claude-opus-4-8")),
      prompt: "hi"
    });
    // The gateway pads every data event with a `p` field; the vendor's parser
    // ignores it, which is exactly why the raw response is handed straight on.
    expect(await result.text).toBe("Hi there! How can I");
  });
});

describe("errors", () => {
  it("lifts the gateway's own error envelope into CloudflareAIError", async () => {
    const binding = fakeGatewayBinding({
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    let caught: unknown;
    try {
      await ai(anthropic("claude-opus-4-8")).doGenerate(callOptions());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloudflareAIError);
    const error = caught as CloudflareAIError;
    expect(error.code).toBe("gateway-error");
    expect(error.status).toBe(402);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toMatch(/Insufficient balance/);
    expect(error.model).toBe("claude-opus-4-8");
  });

  it("hands a vendor's own error to the vendor's own handler", async () => {
    // The dotted-id 404 from `research/43-demos-anthropic-dotted.json`: this
    // is Anthropic's error shape, not the gateway's, so Anthropic reads it.
    const binding = fakeGatewayBinding({
      universal: () =>
        jsonResponse(
          {
            error: {
              message:
                "model: claude-opus-4.8 was not found. Did you mean claude-opus-4-8?",
              type: "not_found_error"
            },
            type: "error"
          },
          { status: 404, headers: gatewayHeaders() }
        )
    });
    const ai = createAI({ binding: asAi(binding) });
    await expect(
      ai(anthropic("claude-opus-4.8")).doGenerate(callOptions())
    ).rejects.toThrow(/Did you mean claude-opus-4-8/);
    expect(binding.universal[0].query.model).toBe("claude-opus-4.8");
  });

  it("refuses a host AI Gateway has no provider for", async () => {
    const binding = fakeGatewayBinding({});
    const ai = createAI({ binding: asAi(binding) });
    const elsewhere = createAnthropic({
      apiKey: "cloudflare",
      baseURL: "https://anthropic.internal.test/v1"
    });
    await expect(
      ai(elsewhere("claude-opus-4-8")).doGenerate(callOptions())
    ).rejects.toThrow(/anthropic\.internal\.test/);
    expect(binding.universal).toHaveLength(0);
  });

  it("refuses a body the universal request cannot carry", async () => {
    const binding = fakeGatewayBinding({});
    const ai = createAI({ binding: asAi(binding) });
    const model = ai.routed(openai.transcription("whisper-1"));
    await expect(
      model.doGenerate({
        audio: new Uint8Array([1, 2, 3]),
        mediaType: "audio/wav"
      })
    ).rejects.toThrow(/JSON body only/);
  });

  it("refuses a model whose provider hides its settings", () => {
    const binding = fakeGatewayBinding({});
    const ai = createAI({ binding: asAi(binding) });
    const opaque = {
      doGenerate: () => Promise.reject(new Error("never")),
      doStream: () => Promise.reject(new Error("never")),
      modelId: "custom-1",
      provider: "custom",
      specificationVersion: "v4",
      supportedUrls: {}
    } as unknown as LanguageModelV4;

    expect(() => ai(opaque)).toThrow(TypeError);
    expect(() => ai(opaque)).toThrow(/no `config` setting/);
  });

  it("refuses a third-party id as a string", () => {
    const binding = fakeGatewayBinding({});
    const ai = createAI({ binding: asAi(binding) });
    expect(() => ai("anthropic/claude-opus-4-8" as typeof WORKERS_AI)).toThrow(
      /@ai-sdk\/anthropic/
    );
  });

  it("refuses a third-party id in a per-call fallback list", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody),
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });

    const caught = await ai(anthropic("claude-opus-4-8"))
      .doGenerate(
        callOptions({
          providerOptions: {
            cloudflare: { fallback: ["anthropic/claude-opus-4.8"] }
          }
        })
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message).toMatch(/@ai-sdk\/anthropic/);
    // The vendor id never reaches either path — least of all `env.AI.run`.
    expect(binding.calls).toHaveLength(0);
    expect(binding.universal).toHaveLength(0);
  });

  it("refuses a third-party id written as a per-model leg", () => {
    const binding = fakeGatewayBinding({});
    const ai = createAI({ binding: asAi(binding) });
    expect(() =>
      ai(anthropic("claude-opus-4-8"), {
        // Only a cast can write this; the throw closes that last door.
        fallback: ["openai/gpt-5-mini" as typeof WORKERS_AI]
      })
    ).toThrow(/@ai-sdk\/openai/);
  });
});

describe("fallback across kinds", () => {
  it("falls back from a vendor model to a Workers AI model", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody),
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(anthropic("claude-opus-4-8"), {
      fallback: [ai(WORKERS_AI)]
    }).doGenerate(callOptions());

    expect(binding.universal).toHaveLength(1);
    expect(binding.calls.map((call) => call.model)).toEqual([WORKERS_AI]);
    expect(result.content).toEqual([{ text: "from @cf", type: "text" }]);
    expect(result.providerMetadata?.cloudflare).toMatchObject({
      model: WORKERS_AI
    });
  });

  it("accepts a bare Workers AI id as a leg", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody),
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(anthropic("claude-opus-4-8"), {
      fallback: [WORKERS_AI]
    }).doGenerate(callOptions());
    expect(result.content).toEqual([{ text: "from @cf", type: "text" }]);
  });

  it("falls back from Workers AI to a routed vendor model", async () => {
    const binding = fakeGatewayBinding({
      run: () =>
        jsonResponse(
          { errors: [{ code: 1, message: "nope" }] },
          { status: 500 }
        ),
      universal: () => anthropicResponse()
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(WORKERS_AI, {
      fallback: [ai(anthropic("claude-opus-4-8"))]
    }).doGenerate(callOptions());

    expect(result.content).toEqual([
      { text: "Hi there! How can I", type: "text" }
    ]);
    expect(result.providerMetadata?.cloudflare).toMatchObject({
      model: "claude-opus-4-8",
      provider: "anthropic"
    });
  });
});

describe("routed non-language models", () => {
  /** The OpenAI images answer shape, one base64 PNG. */
  const IMAGE_BODY = {
    created: 1788451127,
    data: [{ b64_json: "iVBORw0KGgoAAAA" }],
    usage: {
      input_tokens: 3,
      input_tokens_details: { image_tokens: 0, text_tokens: 3 },
      output_tokens: 4,
      total_tokens: 7
    }
  };

  it("gives an image result the `images` array its metadata must live in", async () => {
    const binding = fakeGatewayBinding({
      universal: () => jsonResponse(IMAGE_BODY, { headers: gatewayHeaders() })
    });
    const ai = createAI({ binding: asAi(binding), id: "prod" });
    const model = ai.routed(openai.image("gpt-image-1"));

    const result = await model.doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a fox",
      providerOptions: {},
      seed: undefined,
      size: undefined
    });

    expect(binding.universal[0].provider).toBe("openai");
    expect(binding.universal[0].endpoint).toBe("v1/images/generations");
    // `ImageModelV4ProviderMetadata` requires an `images` array on every
    // provider block; `generateImage` spreads it and crashes without one.
    const ours = result.providerMetadata?.cloudflare;
    expect(Array.isArray(ours?.images)).toBe(true);
    expect(ours?.images).toHaveLength(1);
    expect(ours?.images?.[0]).toMatchObject({
      gateway: "prod",
      model: "gpt-image-1",
      provider: "openai"
    });
  });

  it("survives `generateImage`, which merges the metadata per image", async () => {
    const binding = fakeGatewayBinding({
      universal: () => jsonResponse(IMAGE_BODY, { headers: gatewayHeaders() })
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateImage({
      model: ai.routed(openai.image("gpt-image-1")),
      prompt: "a fox"
    });
    expect(result.image.base64).toBe("iVBORw0KGgoAAAA");
    expect(result.providerMetadata.cloudflare?.images).toHaveLength(1);
  });

  it("hides our per-call bag from the vendor and warns about our knobs", async () => {
    const binding = fakeGatewayBinding({
      universal: () => jsonResponse(IMAGE_BODY, { headers: gatewayHeaders() })
    });
    const ai = createAI({ binding: asAi(binding) });
    /** A vendor model whose own method records what it was asked with. */
    const seen: (SharedV4ProviderOptions | undefined)[] = [];
    const vendor = {
      config: { fetch: globalThis.fetch },
      async doGenerate(
        this: { config: { fetch: typeof globalThis.fetch } },
        call: { providerOptions?: SharedV4ProviderOptions }
      ) {
        seen.push(call.providerOptions);
        await this.config.fetch(
          "https://api.openai.com/v1/images/generations",
          { body: JSON.stringify({ model: "vendor-1" }), method: "POST" }
        );
        return { images: [], warnings: [] };
      },
      modelId: "vendor-1",
      provider: "vendor",
      specificationVersion: "v4" as const
    };

    const result = await ai.routed(vendor).doGenerate({
      providerOptions: {
        cloudflare: { cacheTtl: 30, reasoningEffort: "high" },
        vendor: { style: "vivid" }
      }
    });

    // Read for the gateway layer, then removed — as the language path does.
    expect(seen[0]).toEqual({ vendor: { style: "vivid" } });
    expect(binding.universal[0].options.gateway).toMatchObject({
      cacheTtl: 30
    });
    // The result has a `warnings` array, so the ignored knob is reported.
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        feature: "reasoningEffort",
        type: "unsupported"
      })
    );
  });

  it("does not accept a fallback chain or the Workers AI knobs", () => {
    const binding = fakeGatewayBinding({});
    const ai = createAI({ binding: asAi(binding) });
    // @ts-expect-error `ai.routed` cannot honour a chain, so it does not take one.
    ai.routed(openai.image("gpt-image-1"), { fallback: [WORKERS_AI] });
    // @ts-expect-error `reasoningEffort` is a Workers AI setting.
    ai.routed(openai.image("gpt-image-1"), { reasoningEffort: "high" });
    expect(binding.universal).toHaveLength(0);
  });

  it("leaves a non-image routed result's metadata bare", async () => {
    const binding = fakeGatewayBinding({
      universal: () =>
        jsonResponse(
          { data: [{ embedding: [0.1, 0.2], index: 0 }], model: "x" },
          { headers: gatewayHeaders() }
        )
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai
      .routed(openai.embedding("text-embedding-3-small"))
      .doEmbed({ values: ["hi"] });
    expect(result.providerMetadata?.cloudflare).toMatchObject({
      model: "text-embedding-3-small",
      provider: "openai"
    });
    expect(result.providerMetadata?.cloudflare).not.toHaveProperty("images");
  });
});

describe("fallback legs", () => {
  it("does not let a per-call fallback list re-expand on every leg", async () => {
    // Every leg fails, so the whole chain is walked and each attempt shows.
    const binding = fakeGatewayBinding({
      run: () =>
        jsonResponse(
          { errors: [{ code: 1, message: "nope" }] },
          { status: 500 }
        ),
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });

    const caught = await ai(anthropic("claude-opus-4-8"))
      .doGenerate(
        callOptions({
          providerOptions: { cloudflare: { fallback: [WORKERS_AI] } }
        })
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );

    // One vendor attempt and one Workers AI attempt: the leg must not read the
    // same per-call list and rebuild the chain it is already part of.
    expect(binding.universal).toHaveLength(1);
    expect(binding.calls).toHaveLength(1);
    expect(caught).toBeInstanceOf(CloudflareAIError);
    expect((caught as CloudflareAIError).attempts?.map((a) => a.model)).toEqual(
      ["claude-opus-4-8", WORKERS_AI]
    );
  });

  it("keeps the rest of the per-call bag on a leg", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody),
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    await ai(anthropic("claude-opus-4-8"), {
      fallback: [ai(WORKERS_AI)]
    }).doGenerate(
      callOptions({
        providerOptions: { cloudflare: { id: "per-call", skipCache: true } }
      })
    );
    expect(binding.calls[0].options.gateway).toMatchObject({
      id: "per-call",
      skipCache: true
    });
  });

  it("keeps a configured leg's own Workers AI knobs and headers", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody),
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    const leg = ai(WORKERS_AI, {
      chatTemplateKwargs: { enable_thinking: false },
      headers: { "x-leg": "yes" },
      reasoningEffort: "high"
    });

    await ai(anthropic("claude-opus-4-8"), {
      cacheTtl: 30,
      fallback: [leg],
      id: "prod"
    }).doGenerate(callOptions());

    const call = binding.calls[0];
    expect(call.input.reasoning_effort).toBe("high");
    expect(call.input.chat_template_kwargs).toEqual({
      enable_thinking: false
    });
    expect(call.options.extraHeaders).toMatchObject({ "x-leg": "yes" });
    // The chain's gateway options still reach the leg.
    expect(call.options.gateway).toMatchObject({ cacheTtl: 30, id: "prod" });
  });

  it("sends the chain's gateway to a leg that named its own", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody),
      universal: () => jsonResponse(gatewayError, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    const leg = ai(WORKERS_AI, { cacheTtl: 0, id: "cheap" });

    await ai(anthropic("claude-opus-4-8"), {
      cacheTtl: 60,
      fallback: [leg],
      id: "prod",
      metadata: { chain: "yes" }
    }).doGenerate(callOptions());

    // A chain and its legs travel through one gateway: the chain's wins.
    expect(binding.calls[0].options.gateway).toMatchObject({
      cacheTtl: 60,
      id: "prod",
      metadata: { chain: "yes" }
    });
  });

  it("merges the headers of a model and of its re-wrap", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody)
    });
    const ai = createAI({ binding: asAi(binding) });
    const base = ai(WORKERS_AI, { headers: { "x-team": "a" } });

    await ai(base, { headers: { "x-run": "1" } }).doGenerate(callOptions());

    // Field by field, as `metadata` and the per-call layer already merge.
    expect(binding.calls[0].options.extraHeaders).toMatchObject({
      "x-run": "1",
      "x-team": "a"
    });
  });

  it("keeps a model's own options when it is re-wrapped", async () => {
    const binding = fakeGatewayBinding({
      run: () => jsonResponse(workersAIBody)
    });
    const ai = createAI({ binding: asAi(binding) });
    const configured = ai(WORKERS_AI, { reasoningEffort: "high" });

    await ai(configured, { cacheTtl: 5 }).doGenerate(callOptions());

    expect(binding.calls[0].input.reasoning_effort).toBe("high");
    expect(binding.calls[0].options.gateway).toMatchObject({ cacheTtl: 5 });
  });
});

describe("re-wrapping a configured model", () => {
  it("moves the inner fallback legs onto the gateway named by the re-wrap", async () => {
    const billing = {
      error: [{ code: 2021, message: "Insufficient balance" }],
      httpCode: 402,
      internalCode: 2021,
      messages: [],
      name: "AiGatewayError",
      result: [],
      success: false
    };
    const binding = fakeGatewayBinding({
      run: () =>
        jsonResponse({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "ok", role: "assistant" }
            }
          ]
        }),
      universal: () => jsonResponse(billing, { status: 402 })
    });
    const ai = createAI({ binding: asAi(binding) });
    const configured = ai(anthropic("claude-opus-4-8"), {
      fallback: [ai(WORKERS_AI)],
      id: "old"
    });
    const rewrapped = ai(configured, { id: "new" });

    const result = await rewrapped.doGenerate(callOptions());
    expect(result.content).toEqual([{ text: "ok", type: "text" }]);
    // Both the vendor call and the Workers AI leg went through "new".
    expect(binding.universal[0]?.gatewayId).toBe("new");
    expect(field(binding.calls[0]?.options, "gateway.id")).toBe("new");
  });
});

describe("fetch call forms", () => {
  /** A provider that calls `fetch(new Request(...))` rather than `fetch(url, init)`. */
  class RequestFormModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = "acme.messages";
    readonly modelId = "acme-1";
    readonly supportedUrls = {};
    config = { fetch: globalThis.fetch };

    async doGenerate(): Promise<
      Awaited<ReturnType<LanguageModelV4["doGenerate"]>>
    > {
      const response = await this.config.fetch(
        new Request("https://api.anthropic.com/v1/messages", {
          body: JSON.stringify({ max_tokens: 8, model: "acme-1" }),
          headers: {
            "content-type": "application/json",
            "x-api-key": "placeholder"
          },
          method: "POST"
        })
      );
      const answer = (await response.json()) as { text: string };
      return {
        content: [{ text: answer.text, type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { total: 1 },
          outputTokens: { total: 1 },
          totalTokens: 2
        } as never,
        warnings: []
      };
    }

    doStream(): never {
      throw new Error("not used");
    }
  }

  it("reads the body and headers from a Request when the provider passes one", async () => {
    const binding = fakeGatewayBinding({
      universal: () => jsonResponse({ text: "routed" })
    });
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(new RequestFormModel()).doGenerate(callOptions());

    expect(result.content).toEqual([{ text: "routed", type: "text" }]);
    const call = binding.universal[0];
    expect(call?.provider).toBe("anthropic");
    expect(call?.endpoint).toBe("v1/messages");
    expect(call?.query).toEqual({ max_tokens: 8, model: "acme-1" });
    expect(call?.headers).not.toHaveProperty("x-api-key");
    expect(call?.headers).toHaveProperty("content-type", "application/json");
  });
});
