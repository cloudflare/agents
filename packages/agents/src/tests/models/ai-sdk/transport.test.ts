import type { ProviderV4 } from "@ai-sdk/provider";
import { createProviderRegistry, generateText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudflareAIError,
  createAI,
  type AISettings
} from "../../../models/ai-sdk";
import {
  asAi,
  callOptions,
  collect,
  fakeBinding,
  jsonResponse
} from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const plainBody = {
  choices: [
    {
      finish_reason: "stop",
      message: { content: "ok", role: "assistant" }
    }
  ]
};

describe("binding transport", () => {
  it("passes model, input and run options through", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL, { cacheTtl: 60, gateway: "my-gw" }).doGenerate(
      callOptions({ maxOutputTokens: 128, temperature: 0.5 })
    );
    const call = binding.calls[0];

    expect(call.model).toBe(MODEL);
    expect(call.input.max_tokens).toBe(128);
    expect(call.input.temperature).toBe(0.5);
    expect(call.options).toMatchObject({
      gateway: { cacheTtl: 60, id: "my-gw" },
      returnRawResponse: true
    });
    // No extra headers were configured, so the key is omitted entirely.
    expect(call.options).not.toHaveProperty("extraHeaders");
  });

  it("sends extraHeaders including session affinity", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL, {
      headers: { "x-custom": "1" },
      sessionAffinity: "user-7"
    }).doGenerate(callOptions());

    expect(binding.calls[0].options.extraHeaders).toEqual({
      "x-custom": "1",
      "x-session-affinity": "user-7"
    });
  });

  it("calls run as a method so the binding keeps its receiver", async () => {
    let receiver: unknown;
    const binding = {
      aiGatewayLogId: "binding-log-id",
      calls: [],
      async run(this: unknown) {
        receiver = this;
        return jsonResponse(plainBody);
      }
    };
    const ai = createAI({ binding: binding as unknown as Ai });
    await ai(MODEL).doGenerate(callOptions());
    expect(receiver).toBe(binding);
  });

  it("falls back to the binding log id when no header is present", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    binding.aiGatewayLogId = "binding-log-id";
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());

    expect(result.providerMetadata?.cloudflare).toMatchObject({
      logId: "binding-log-id"
    });
  });

  it("forwards the abort signal", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    const controller = new AbortController();
    await ai(MODEL).doGenerate(callOptions({ abortSignal: controller.signal }));
    expect(binding.calls[0].options.signal).toBe(controller.signal);
  });
});

describe("thrown binding failures", () => {
  it("does not retry a TypeError thrown by the binding itself", async () => {
    // The binding is the only backend: there is no `fetch` to reject, so a
    // `TypeError` is a programming error, and retrying it burns the retry
    // budget on every fallback leg.
    const binding = fakeBinding(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const ai = createAI({ binding: asAi(binding) });
    let caught: unknown;
    try {
      await ai(MODEL).doGenerate(callOptions());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloudflareAIError);
    expect((caught as CloudflareAIError).isRetryable).toBe(false);
  });

  it("does not retry a thrown error with no recognised code", async () => {
    const binding = fakeBinding(() => {
      throw new Error("5006: AiError: Bad input");
    });
    const ai = createAI({ binding: asAi(binding) });
    let caught: unknown;
    try {
      await ai(MODEL).doGenerate(callOptions());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloudflareAIError);
    expect((caught as CloudflareAIError).isRetryable).toBe(false);
  });

  it("requires the AI binding: there is no HTTP transport", () => {
    expect(() => createAI({} as AISettings)).toThrow(/requires \{ binding \}/);
  });
});

describe("cloudflare envelope", () => {
  it("unwraps { success, result } and leaves bare bodies alone", async () => {
    const binding = fakeBinding((_call, index) =>
      index === 0
        ? jsonResponse({
            errors: [],
            messages: [],
            result: plainBody,
            success: true
          })
        : jsonResponse(plainBody)
    );
    const ai = createAI({ binding: asAi(binding) });
    const wrapped = await ai(MODEL).doGenerate(callOptions());
    const bare = await ai(MODEL).doGenerate(callOptions());

    expect(wrapped.content).toEqual([{ text: "ok", type: "text" }]);
    expect(bare.content).toEqual([{ text: "ok", type: "text" }]);
  });

  it("does not unwrap a provider payload that merely has a result field", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({ response: "kept", result: "not an envelope" })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());
    expect(result.content).toEqual([{ text: "kept", type: "text" }]);
  });

  it("fails on a 2xx envelope that reports success: false", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        error: [{ code: 3040, message: "Capacity temporarily exceeded" }],
        messages: [],
        name: "AiGatewayError",
        result: [],
        success: false
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    let caught: unknown;
    try {
      await ai(MODEL).doGenerate(callOptions());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloudflareAIError);
    const error = caught as CloudflareAIError;
    expect(error.code).toBe("gateway-error");
    expect(error.message).toBe("Capacity temporarily exceeded");
  });
});

describe("sse decoding", () => {
  const stream = async (body: string) => {
    const binding = fakeBinding(
      () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" }
        })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doStream(callOptions());
    return await collect(result.stream);
  };

  const textOf = (parts: { type: string; delta?: string }[]) =>
    parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");

  it("handles LF endings, comments and other SSE fields", async () => {
    const parts = await stream(
      [
        ": keep-alive",
        "event: message",
        'data: {"choices":[{"delta":{"content":"a"},"index":0}]}',
        "",
        "id: 7",
        "retry: 100",
        'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop","index":0}]}',
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n")
    );
    expect(textOf(parts)).toBe("ab");
  });

  it("joins multi-line data fields", async () => {
    const parts = await stream(
      'data: {"choices":[{"delta":{"content":"multi"},\ndata: "index":0}]}\n\ndata: [DONE]\n\n'
    );
    expect(textOf(parts)).toBe("multi");
  });

  it("flushes a final event the server never terminated", async () => {
    const parts = await stream(
      'data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop","index":0}]}'
    );
    expect(textOf(parts)).toBe("tail");
  });

  it("handles bare CR line terminators", async () => {
    const parts = await stream(
      'data: {"choices":[{"delta":{"content":"cr"},"finish_reason":"stop","index":0}]}\r\rdata: [DONE]\r\r'
    );
    expect(textOf(parts)).toBe("cr");
  });

  it("holds back a trailing CR until the next chunk decides CRLF", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"split"},"index":0}]}\r\n\r',
      '\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\r\n\r\n'
    ];
    const binding = fakeBinding(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const part of chunks) {
                controller.enqueue(encoder.encode(part));
              }
              controller.close();
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doStream(callOptions());
    const parts = await collect(result.stream);
    expect(textOf(parts)).toBe("split");
  });

  it("cancels the upstream body when the consumer cancels", async () => {
    let cancelled = false;
    const binding = fakeBinding(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"a"},"index":0}]}\n\n'
                )
              );
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions());
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(cancelled).toBe(true);
  });

  it("tolerates a data field with no space after the colon", async () => {
    const parts = await stream(
      'data:{"choices":[{"delta":{"content":"tight"},"finish_reason":"stop","index":0}]}\r\n\r\ndata:[DONE]\r\n\r\n'
    );
    expect(textOf(parts)).toBe("tight");
  });
});

describe("provider shape", () => {
  it("satisfies the AI SDK provider contract", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });

    expect(ai.specificationVersion).toBe("v4");
    // Every `ProviderV4` model method is present, so the provider drops into
    // a registry whole rather than only for language models.
    expect(
      ai.imageModel("@cf/black-forest-labs/flux-1-schnell").specificationVersion
    ).toBe("v4");
    expect(
      ai.transcriptionModel("@cf/openai/whisper-large-v3-turbo").modelId
    ).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(ai.speechModel("@cf/deepgram/aura-1").provider).toBe("cloudflare");
    expect(
      ai.rerankingModel("@cf/baai/bge-reranker-base").specificationVersion
    ).toBe("v4");

    const registry = createProviderRegistry({ cloudflare: ai });
    const model = registry.languageModel(`cloudflare:${MODEL}`);
    expect(model.modelId).toBe(MODEL);
    const result = await generateText({ model, prompt: "hi" });
    expect(result.text).toBe("ok");
  });

  it("is a ProviderV4, so it can be the AI SDK default provider", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });

    // The assignment is the assertion: `ProviderV4` resolves models by string
    // alone, and a provider that does not satisfy it cannot be a registry
    // entry or the SDK's default.
    const provider: ProviderV4 = ai;
    expect(provider.languageModel(MODEL).modelId).toBe(MODEL);

    globalThis.AI_SDK_DEFAULT_PROVIDER = ai;
    const result = await generateText({ model: MODEL, prompt: "hi" });
    expect(result.text).toBe("ok");
    expect(binding.calls[0]?.model).toBe(MODEL);
  });

  afterEach(() => {
    globalThis.AI_SDK_DEFAULT_PROVIDER = undefined;
  });
});

describe("model ids", () => {
  it("takes Workers AI ids only, and says what to do with the rest", () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });

    expect(ai(MODEL).modelId).toBe(MODEL);
    // A vendor id is not an id here: the vendor's own provider builds it.
    expect(() => ai("openai/gpt-5-mini" as typeof MODEL)).toThrow(TypeError);
    expect(() => ai("openai/gpt-5-mini" as typeof MODEL)).toThrow(
      /@ai-sdk\/openai/
    );
    expect(() => ai("anthropic/claude-opus-4-8" as typeof MODEL)).toThrow(
      /@ai-sdk\/anthropic/
    );
    expect(() => ai("google/gemini-3-flash" as typeof MODEL)).toThrow(
      /@ai-sdk\/google/
    );
    expect(() => ai("gpt-5-mini" as typeof MODEL)).toThrow(
      /is not a Workers AI model id/
    );
  });

  it("declares no URL support: Workers AI takes bytes", () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    expect(ai(MODEL).supportedUrls).toEqual({});
  });
});
