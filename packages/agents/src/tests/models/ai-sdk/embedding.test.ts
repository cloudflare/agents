import { TooManyEmbeddingValuesForCallError } from "@ai-sdk/provider";
import { embedMany } from "ai";
import { describe, expect, it } from "vitest";
import { CloudflareAIError, createAI } from "../../../models/ai-sdk";
import { asAi, fakeBinding, field, jsonResponse } from "./helpers";

const MODEL = "@cf/baai/bge-base-en-v1.5";

/** The live bare embedding body, including the undocumented `pooling` key. */
const embeddingBody = {
  data: [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6]
  ],
  pooling: "mean",
  shape: [2, 3],
  usage: { completion_tokens: 0, prompt_tokens: 6, total_tokens: 6 }
};

describe("embeddings", () => {
  it("sends { text } and reads the bare response", async () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.embedding(MODEL).doEmbed({
      values: ["hello", "world"]
    });

    expect(binding.calls[0].model).toBe(MODEL);
    expect(binding.calls[0].input).toEqual({ text: ["hello", "world"] });
    expect(result.embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6]
    ]);
    expect(result.usage).toEqual({ tokens: 6 });
    expect(result.warnings).toEqual([]);
  });

  it("unwraps the Cloudflare envelope", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        errors: [],
        messages: [],
        result: embeddingBody,
        success: true
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.embedding(MODEL).doEmbed({ values: ["a", "b"] });
    expect(result.embeddings).toHaveLength(2);
  });

  it("omits usage when the response carries none", async () => {
    const binding = fakeBinding(() => jsonResponse({ data: [[1, 2]] }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.embedding(MODEL).doEmbed({ values: ["a"] });

    expect(result.embeddings).toEqual([[1, 2]]);
    expect(result.usage).toBeUndefined();
  });

  it("exposes the same model under textEmbeddingModel", async () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    const model = ai.textEmbeddingModel(MODEL);

    expect(model.modelId).toBe(MODEL);
    expect(model.specificationVersion).toBe("v4");
    expect(model.maxEmbeddingsPerCall).toBe(3000);
    expect(model.supportsParallelCalls).toBe(true);
    await model.doEmbed({ values: ["a", "b"] });
    expect(binding.calls).toHaveLength(1);
  });

  it("rejects a batch larger than the Workers AI limit", async () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    const values = Array.from({ length: 3001 }, (_value, index) => `v${index}`);

    await expect(
      ai.embedding(MODEL).doEmbed({ values })
    ).rejects.toBeInstanceOf(TooManyEmbeddingValuesForCallError);
    expect(binding.calls).toHaveLength(0);
  });

  it("applies gateway options and session affinity", async () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({
      binding: asAi(binding),
      gateway: { id: "provider-gw" }
    });
    await ai
      .embedding(MODEL, { cacheTtl: 90, sessionAffinity: "s-1" })
      .doEmbed({ values: ["a", "b"] });

    expect(binding.calls[0].options.gateway).toEqual({
      cacheTtl: 90,
      id: "provider-gw"
    });
    expect(binding.calls[0].options.extraHeaders).toEqual({
      "x-session-affinity": "s-1"
    });
  });

  it("drops undefined call headers rather than forwarding them", async () => {
    // `EmbeddingModelV4CallOptions` forbids an undefined value, but the
    // language-model call options allow one and a JavaScript caller can pass
    // one either way; it must not reach the binding as the string "undefined".
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    const headers = {
      "x-keep": "yes",
      "x-skip": undefined
    } as unknown as Record<string, string>;
    await ai.embedding(MODEL).doEmbed({ headers, values: ["a"] });

    expect(binding.calls[0].options.extraHeaders).toEqual({ "x-keep": "yes" });
  });

  it("maps an error response to a CloudflareAIError", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          error: [{ code: 7003, message: `Model not found: ${MODEL}` }],
          name: "AiGatewayError"
        },
        { status: 404 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    await expect(
      ai.embedding(MODEL).doEmbed({ values: ["a"] })
    ).rejects.toBeInstanceOf(CloudflareAIError);
  });

  it("exposes the same model under the ProviderV4 embeddingModel name", () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    expect(ai.embeddingModel(MODEL).modelId).toBe(MODEL);
    expect(ai.specificationVersion).toBe("v4");
  });

  it("falls back to another embedding model when the first fails", async () => {
    const fallbackModel = "@cf/baai/bge-m3";
    const binding = fakeBinding((call) =>
      call.model === MODEL
        ? jsonResponse(
            {
              error: [{ code: 3040, message: "Capacity exceeded" }],
              name: "AiGatewayError"
            },
            { status: 429 }
          )
        : jsonResponse(embeddingBody)
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai
      .embedding(MODEL, { fallback: [fallbackModel] })
      .doEmbed({ values: ["a", "b"] });

    expect(binding.calls.map((call) => call.model)).toEqual([
      MODEL,
      fallbackModel
    ]);
    expect(result.embeddings).toHaveLength(2);
  });

  it("refuses a third-party id in a per-call fallback list", async () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });

    await expect(
      ai.embedding(MODEL).doEmbed({
        providerOptions: {
          cloudflare: { fallback: ["openai/text-embedding-3-small"] }
        },
        values: ["a"]
      })
    ).rejects.toThrow(/not a Workers AI model id/);
    // The modality models share the per-call gate, so nothing was sent.
    expect(binding.calls).toHaveLength(0);
  });

  it("takes fallback legs as ids only, never as model objects", () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    // A leg the run path cannot resolve must not type-check: the modality
    // models look a leg up by id, and an object would be dropped in silence.
    const objectLegs = [ai("@cf/baai/bge-m3")];
    // @ts-expect-error a modality leg is a Workers AI id.
    ai.embedding(MODEL, { fallback: objectLegs });
    // @ts-expect-error the same rule on every Workers-AI-only method.
    ai.image("@cf/black-forest-labs/flux-1-schnell", { fallback: objectLegs });
    expect(
      ai.embedding(MODEL, { fallback: ["@cf/baai/bge-m3"] })
    ).toBeDefined();
  });

  it("works through embedMany", async () => {
    const binding = fakeBinding(() => jsonResponse(embeddingBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await embedMany({
      model: ai.embedding(MODEL),
      values: ["hello", "world"]
    });

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.usage.tokens).toBe(6);
    expect(field(binding.calls[0].input, "text")).toEqual(["hello", "world"]);
    expect(binding.calls[0].options.gateway).toMatchObject({ id: "default" });
  });
});
