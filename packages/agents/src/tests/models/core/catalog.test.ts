import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/ai-sdk";
import type {
  CloudflareEmbeddingModelId,
  CloudflareImageModelId,
  WorkersAIModelId
} from "../../../models/core/catalog";
import { asAi, fakeBinding, jsonResponse } from "../ai-sdk/helpers";

/**
 * The ambient `AiModels` catalog also lists `@hf/…` ids, which every entry
 * point here rejects at runtime. The types must not offer them: a suggestion
 * that always throws is worse than no suggestion.
 */
describe("catalog ids are `@cf/` only", () => {
  it("accepts a Workers AI id and rejects a non-`@cf/` catalog id", () => {
    const suggested: WorkersAIModelId =
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
    const anySlug: WorkersAIModelId = "@cf/some/future-model";
    // @ts-expect-error `@hf/` ids are in the ambient catalog but not accepted.
    const huggingFace: WorkersAIModelId = "@hf/thebloke/llama-2-13b-chat-awq";
    // @ts-expect-error a vendor id is a model object, never a string.
    const vendor: WorkersAIModelId = "anthropic/claude-opus-4-8";

    expect([suggested, anySlug, huggingFace, vendor]).toHaveLength(4);
  });

  it("holds the modality ids to the same rule", () => {
    const embedding: CloudflareEmbeddingModelId = "@cf/baai/bge-base-en-v1.5";
    const image: CloudflareImageModelId =
      "@cf/black-forest-labs/flux-1-schnell";
    // @ts-expect-error the modality methods are Workers AI only.
    const vendorEmbedding: CloudflareEmbeddingModelId =
      "openai/text-embedding-3-small";

    expect([embedding, image, vendorEmbedding]).toHaveLength(3);
  });

  it("suggests the FLUX.2 image models, which ai.image() sends as multipart", () => {
    type SuggestsFlux2 = Extract<
      CloudflareImageModelId,
      "@cf/black-forest-labs/flux-2-klein-9b"
    >;
    type SuggestsFlux1 = Extract<
      CloudflareImageModelId,
      "@cf/black-forest-labs/flux-1-schnell"
    >;
    const suggestedFlux2: SuggestsFlux2 extends never ? false : true = true;
    const suggestedFlux1: SuggestsFlux1 extends never ? false : true = true;

    expect([suggestedFlux2, suggestedFlux1]).toHaveLength(2);
  });

  it("refuses an `@hf/` id at runtime too", () => {
    const ai = createAI({
      binding: asAi(fakeBinding(() => jsonResponse({})))
    });
    expect(() =>
      ai("@hf/thebloke/llama-2-13b-chat-awq" as WorkersAIModelId)
    ).toThrow(/not a model id this provider knows/);
  });
});
