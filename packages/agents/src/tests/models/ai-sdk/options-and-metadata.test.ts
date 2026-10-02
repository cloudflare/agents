import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/ai-sdk";
import {
  asAi,
  callOptions,
  collect,
  fakeBinding,
  jsonResponse,
  sseResponse
} from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const plainBody = {
  choices: [
    { finish_reason: "stop", message: { content: "ok", role: "assistant" } }
  ]
};

describe("option precedence", () => {
  it("applies the flat gateway keys given to createAI", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding), cacheTtl: 60, id: "prod" });

    await ai(MODEL).doGenerate(callOptions());

    expect(binding.calls[0].options.gateway).toEqual({
      cacheTtl: 60,
      id: "prod"
    });
  });

  it("takes call over model over provider for the gateway", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({
      binding: asAi(binding),
      gateway: { cacheTtl: 10, collectLog: true, id: "provider-gw" }
    });
    const model = ai(MODEL, { cacheTtl: 20, gateway: "model-gw" });

    await model.doGenerate(callOptions());
    expect(binding.calls[0].options.gateway).toEqual({
      cacheTtl: 20,
      collectLog: true,
      id: "model-gw"
    });

    await model.doGenerate(
      callOptions({
        providerOptions: {
          cloudflare: { cacheTtl: 30, gateway: { id: "call-gw" } }
        }
      })
    );
    expect(binding.calls[1].options.gateway).toEqual({
      cacheTtl: 30,
      collectLog: true,
      id: "call-gw"
    });
  });

  it("merges metadata across the three layers", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({
      binding: asAi(binding),
      gateway: { metadata: { app: "demo", tier: "free" } }
    });
    await ai(MODEL, { metadata: { tier: "pro" } }).doGenerate(
      callOptions({
        providerOptions: { cloudflare: { metadata: { userId: "u1" } } }
      })
    );

    expect(binding.calls[0].options.gateway).toEqual({
      id: "default",
      metadata: { app: "demo", tier: "pro", userId: "u1" }
    });
  });

  it("layers headers: call options, then model options, then affinity", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL, {
      headers: { "x-a": "model", "x-b": "model" },
      sessionAffinity: "affinity-1"
    }).doGenerate(
      callOptions({
        headers: { "x-a": "request", "x-c": "request" },
        providerOptions: {
          cloudflare: {
            headers: { "x-b": "call" },
            sessionAffinity: "affinity-2"
          }
        }
      })
    );

    expect(binding.calls[0].options.extraHeaders).toEqual({
      "x-a": "model",
      "x-b": "call",
      "x-c": "request",
      "x-session-affinity": "affinity-2"
    });
  });

  it("takes per-call reasoning effort over the unified reasoning option", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL, { reasoningEffort: "medium" }).doGenerate(
      callOptions({
        providerOptions: { cloudflare: { reasoningEffort: null } },
        reasoning: "high"
      })
    );
    // A null effort means "off"; on Workers AI that is the chat-template switch.
    expect(binding.calls[0].input).not.toHaveProperty("reasoning_effort");
    expect(
      (binding.calls[0].input.chat_template_kwargs as Record<string, unknown>)
        .enable_thinking
    ).toBe(false);
  });

  it("ignores malformed providerOptions rather than failing the call", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL).doGenerate(
      callOptions({
        providerOptions: {
          cloudflare: {
            cacheTtl: "sixty",
            fallback: [1, "@cf/other"],
            headers: { good: "yes", nested: 5 },
            reasoningEffort: "extreme",
            skipCache: "yes"
          }
        }
      })
    );

    expect(binding.calls[0].options.gateway).toEqual({ id: "default" });
    expect(binding.calls[0].options.extraHeaders).toEqual({ good: "yes" });
    expect(binding.calls[0].input).not.toHaveProperty("reasoning_effort");
  });

  it("treats an explicit undefined in a gateway object as unset", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding), gateway: "provider-gw" });
    await ai(MODEL, { gateway: { cacheTtl: 5, id: undefined } }).doGenerate(
      callOptions()
    );

    expect(binding.calls[0].options.gateway).toEqual({
      cacheTtl: 5,
      id: "provider-gw"
    });
  });

  it("drops metadata values and retry fields the gateway would reject", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai(MODEL).doGenerate(
      callOptions({
        providerOptions: {
          cloudflare: {
            gateway: {
              metadata: { deep: { no: true }, list: [1], ok: "yes", n: 3 },
              retries: {
                backoff: "cubic",
                maxAttempts: "3",
                retryDelayMs: 100
              }
            }
          }
        }
      })
    );

    expect(binding.calls[0].options.gateway).toEqual({
      id: "default",
      metadata: { n: 3, ok: "yes" },
      retries: { retryDelayMs: 100 }
    });
  });

  it("reads providerOptions passed through generateText", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    await generateText({
      model: ai(MODEL),
      prompt: "hi",
      providerOptions: {
        cloudflare: { metadata: { userId: "u1" }, skipCache: true }
      }
    });

    expect(binding.calls[0].options.gateway).toEqual({
      id: "default",
      metadata: { userId: "u1" },
      skipCache: true
    });
  });
});

describe("provider metadata", () => {
  it("reads every cf-aig header off a non-streaming response", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(plainBody, {
        headers: {
          "cf-aig-cache-status": "HIT",
          "cf-aig-log-id": "01M1KEHQ",
          "cf-aig-run-id": "run-9",
          "cf-aig-step": "2"
        }
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL, { gateway: "gw-x" }).doGenerate(
      callOptions()
    );

    expect(result.providerMetadata?.cloudflare).toEqual({
      cacheStatus: "HIT",
      gateway: "gw-x",
      logId: "01M1KEHQ",
      model: MODEL,
      runId: "run-9",
      step: 2
    });
    expect(result.response?.headers?.["cf-aig-log-id"]).toBe("01M1KEHQ");
  });

  it("omits absent headers instead of emitting undefined values", async () => {
    const binding = fakeBinding(() => jsonResponse(plainBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(MODEL).doGenerate(callOptions());
    const metadata = result.providerMetadata?.cloudflare ?? {};

    expect(Object.keys(metadata).sort()).toEqual(["gateway", "model"]);
  });

  it("stamps the metadata onto the stream finish part", async () => {
    const binding = fakeBinding(() =>
      sseResponse(
        [
          JSON.stringify({
            choices: [
              { delta: { content: "x" }, finish_reason: "stop", index: 0 }
            ]
          }),
          "[DONE]"
        ],
        { headers: { "cf-aig-cache-status": "MISS", "cf-aig-log-id": "L1" } }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream, response } = await ai(MODEL).doStream(callOptions());
    const parts = await collect(stream);
    const finish = parts.at(-1);

    expect(response?.headers?.["cf-aig-log-id"]).toBe("L1");
    if (finish?.type === "finish") {
      expect(finish.providerMetadata?.cloudflare).toEqual({
        cacheStatus: "MISS",
        gateway: "default",
        logId: "L1",
        model: MODEL
      });
    }
  });

  it("emits stream-start exactly once, even for an empty stream", async () => {
    const binding = fakeBinding(() => sseResponse([]));
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(MODEL).doStream(callOptions({ topK: 5 }));
    const parts = await collect(stream);

    expect(parts.filter((part) => part.type === "stream-start")).toHaveLength(
      1
    );
    const start = parts[0];
    if (start.type === "stream-start") {
      expect(start.warnings).toContainEqual(
        expect.objectContaining({ feature: "topK" })
      );
    }
    expect(parts.at(-1)?.type).toBe("finish");
  });
});
