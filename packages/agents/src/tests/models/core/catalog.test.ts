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
    const suggested: WorkersAIModelId = "@cf/zai-org/glm-4.7-flash";
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

  it("does not suggest the image models the run path cannot serve", () => {
    // The FLUX.2 family declares a required `multipart` object body and no
    // `prompt`, which the JSON run path cannot carry (live: 400 `required
    // properties at "/" are 'multipart'`), so it stays out of the suggested
    // arm exactly as the Deepgram recognisers do for transcription.
    type SuggestsFlux2 = Extract<
      CloudflareImageModelId,
      "@cf/black-forest-labs/flux-2-dev"
    >;
    type SuggestsFlux1 = Extract<
      CloudflareImageModelId,
      "@cf/black-forest-labs/flux-1-schnell"
    >;
    const notSuggested: SuggestsFlux2 extends never ? true : false = true;
    const suggested: SuggestsFlux1 extends never ? false : true = true;
    // The template arm still accepts any `@cf/` slug: the catalog is
    // server-side and moves on its own.
    const stillAssignable: CloudflareImageModelId =
      "@cf/black-forest-labs/flux-2-dev";

    expect([notSuggested, suggested, stillAssignable]).toHaveLength(3);
  });

  it("refuses a non-`@cf/` id at runtime too, with the same advice", () => {
    const ai = createAI({
      binding: asAi(fakeBinding(() => jsonResponse({})))
    });
    expect(() =>
      ai("@hf/thebloke/llama-2-13b-chat-awq" as WorkersAIModelId)
    ).toThrow(/not a Workers AI model id/);
  });
});
