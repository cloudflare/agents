import { generateImage, generateSpeech, rerank, transcribe } from "ai";
import { describe, expect, it } from "vitest";
import { CloudflareAIError, createAI } from "../../../models/ai-sdk";
import { asAi, fakeBinding, field, jsonResponse } from "./helpers";

const FLUX = "@cf/black-forest-labs/flux-1-schnell";
const SDXL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";
const AURA = "@cf/deepgram/aura-1";
const MELOTTS = "@cf/myshell-ai/melotts";
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const WHISPER_TINY = "@cf/openai/whisper-tiny-en";
const RERANKER = "@cf/baai/bge-reranker-base";

/** The first bytes of a JPEG, as flux-1-schnell's base64 starts. */
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/";
/** A PNG signature, as the raw-bytes models answer with. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
/** An MP3 frame header, as aura answers with. */
const MP3_BYTES = new Uint8Array([0xff, 0xf3, 0x64, 0xc4, 0x00, 0x16]);

/** A binary `Response`, the shape the run path uses for PNG and MP3 answers. */
function binaryResponse(
  bytes: Uint8Array<ArrayBuffer>,
  mediaType: string
): Response {
  return new Response(bytes, {
    headers: { "content-type": mediaType },
    status: 200
  });
}

/** The live flux-1-schnell body: JSON, base64 JPEG, plus usage. */
const fluxBody = {
  image: JPEG_BASE64,
  usage: {
    completion_tokens: 0,
    prompt_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    total_tokens: 0
  }
};

/** The live whisper-large-v3-turbo body, trimmed to the fields we read. */
const whisperBody = {
  segments: [
    {
      avg_logprob: -0.41,
      end: 1.38,
      no_speech_prob: 0,
      start: 0,
      temperature: 0,
      text: " Hello from Cloudflare.",
      word_count: 3,
      words: [
        { end: 0.58, start: 0, word: " Hello" },
        { end: 0.8, start: 0.58, word: " from" },
        { end: 1.38, start: 0.8, word: " Cloudflare." }
      ]
    }
  ],
  text: "Hello from Cloudflare.",
  transcription_info: {
    duration: 1.584,
    duration_after_vad: 1.584,
    language: "en",
    language_probability: 0.9995
  },
  vtt: "WEBVTT\n\n00:00.000 --> 00:00.580\n Hello\n\n",
  word_count: 3
};

/** The live bge-reranker-base body: already sorted, `id` is the input index. */
const rerankBody = {
  response: [
    { id: 1, score: 0.9544025659561157 },
    { id: 0, score: 0.00003775554432650097 }
  ],
  usage: { completion_tokens: 0, prompt_tokens: 32, total_tokens: 32 }
};

describe("image generation", () => {
  it("reads the JSON `{ image }` shape and keeps the base64", async () => {
    const binding = fakeBinding(() => jsonResponse(fluxBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.image(FLUX).doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a cyberpunk lizard",
      providerOptions: {},
      seed: undefined,
      size: undefined
    });

    expect(binding.calls[0].model).toBe(FLUX);
    expect(binding.calls[0].input).toEqual({ prompt: "a cyberpunk lizard" });
    expect(result.images).toEqual([JPEG_BASE64]);
    expect(result.response.modelId).toBe(FLUX);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    });
    // The bytes, not the model name, decide the media type: flux answers JPEG.
    expect(result.providerMetadata?.cloudflare.images).toEqual([
      { mediaType: "image/jpeg" }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("reads a raw `image/png` body as bytes", async () => {
    const binding = fakeBinding(() => binaryResponse(PNG_BYTES, "image/png"));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.image(SDXL).doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a cyberpunk cat",
      providerOptions: {},
      seed: 7,
      size: "1024x768"
    });

    expect(binding.calls[0].input).toEqual({
      height: 768,
      prompt: "a cyberpunk cat",
      seed: 7,
      width: 1024
    });
    expect(result.images[0]).toBeInstanceOf(Uint8Array);
    expect(result.images[0]).toEqual(PNG_BYTES);
    expect(result.providerMetadata?.cloudflare.images).toEqual([
      { mediaType: "image/png" }
    ]);
    expect(result.usage).toBeUndefined();
  });

  it("sends the generation knobs from providerOptions.cloudflare", async () => {
    const binding = fakeBinding(() => binaryResponse(PNG_BYTES, "image/png"));
    const ai = createAI({ binding: asAi(binding) });
    await ai.image(SDXL).doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a fox",
      providerOptions: {
        cloudflare: {
          guidance: 8,
          negativePrompt: "blurry",
          steps: 12,
          strength: 0.6
        }
      },
      seed: undefined,
      size: undefined
    });

    expect(binding.calls[0].input).toEqual({
      guidance: 8,
      negative_prompt: "blurry",
      num_steps: 12,
      prompt: "a fox",
      strength: 0.6
    });
  });

  it("warns for everything flux-1 cannot take, and sends `steps`", async () => {
    const binding = fakeBinding(() => jsonResponse(fluxBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.image(FLUX).doGenerate({
      aspectRatio: "16:9",
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a fox",
      providerOptions: { cloudflare: { guidance: 8, steps: 4 } },
      seed: 3,
      size: "512x512"
    });

    expect(binding.calls[0].input).toEqual({ prompt: "a fox", steps: 4 });
    expect(result.warnings.map((warning) => warning.type)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported"
    ]);
    const features = result.warnings.flatMap((warning) =>
      warning.type === "unsupported" ? [warning.feature] : []
    );
    expect(features).toEqual(["aspectRatio", "size", "seed", "guidance"]);
  });

  it("passes an input image and mask through for img2img", async () => {
    const binding = fakeBinding(() => binaryResponse(PNG_BYTES, "image/png"));
    const ai = createAI({ binding: asAi(binding) });
    await ai.image(SDXL).doGenerate({
      aspectRatio: undefined,
      files: [
        { data: PNG_BYTES, mediaType: "image/png", type: "file" },
        { data: PNG_BYTES, mediaType: "image/png", type: "file" }
      ],
      mask: { data: "AAEC", mediaType: "image/png", type: "file" },
      n: 1,
      prompt: "repaint",
      providerOptions: {},
      seed: undefined,
      size: undefined
    });

    expect(field(binding.calls[0].input, "image_b64")).toBe("iVBORw0KGgo=");
    expect(field(binding.calls[0].input, "mask")).toEqual([0, 1, 2]);
  });

  it("fans a direct doGenerate n>1 out into one call per image", async () => {
    const binding = fakeBinding(() => jsonResponse(fluxBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.image(FLUX).doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 3,
      prompt: "a fox",
      providerOptions: {},
      seed: undefined,
      size: undefined
    });

    expect(binding.calls).toHaveLength(3);
    expect(result.images).toHaveLength(3);
  });

  it("errors when the JSON answer carries no image", async () => {
    const binding = fakeBinding(() => jsonResponse({ usage: {} }));
    const ai = createAI({ binding: asAi(binding) });
    await expect(
      ai.image(FLUX).doGenerate({
        aspectRatio: undefined,
        files: undefined,
        mask: undefined,
        n: 1,
        prompt: "a fox",
        providerOptions: {},
        seed: undefined,
        size: undefined
      })
    ).rejects.toBeInstanceOf(CloudflareAIError);
  });

  it("maps the Workers AI error envelope to a CloudflareAIError", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          description: "Error: Type mismatch of '/prompt'",
          httpCode: 400,
          internalCode: 5006,
          message: "AiError: Bad input",
          name: "AiError"
        },
        { status: 400 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    // `doGenerate` is typed as a `PromiseLike`, so it is adopted first.
    const error = await Promise.resolve(
      ai.image(FLUX).doGenerate({
        aspectRatio: undefined,
        files: undefined,
        mask: undefined,
        n: 1,
        prompt: "a fox",
        providerOptions: {},
        seed: undefined,
        size: undefined
      })
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CloudflareAIError);
    expect((error as CloudflareAIError).status).toBe(400);
    expect((error as CloudflareAIError).code).toBe("bad-request");
  });

  it("works through generateImage", async () => {
    const binding = fakeBinding(() => jsonResponse(fluxBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateImage({
      model: ai.imageModel(FLUX),
      prompt: "a cyberpunk lizard"
    });

    expect(result.image.base64).toBe(JPEG_BASE64);
    expect(result.image.mediaType).toBe("image/jpeg");
    expect(binding.calls[0].model).toBe(FLUX);
    expect(field(binding.calls[0].input, "prompt")).toBe("a cyberpunk lizard");
  });

  it("splits generateImage n across calls, one image per call", async () => {
    const binding = fakeBinding(() => jsonResponse(fluxBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateImage({
      model: ai.image(FLUX),
      n: 2,
      prompt: "a fox"
    });

    expect(binding.calls).toHaveLength(2);
    expect(result.images).toHaveLength(2);
  });
});

describe("speech", () => {
  it("sends { text } and returns the MP3 bytes", async () => {
    const binding = fakeBinding(() => binaryResponse(MP3_BYTES, "audio/mpeg"));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.speech(AURA).doGenerate({
      text: "Hello from Cloudflare"
    });

    expect(binding.calls[0].model).toBe(AURA);
    expect(binding.calls[0].input).toEqual({ text: "Hello from Cloudflare" });
    expect(result.audio).toEqual(MP3_BYTES);
    expect(result.response.modelId).toBe(AURA);
    expect(result.warnings).toEqual([]);
  });

  it("maps voice to speaker and outputFormat to encoding", async () => {
    const binding = fakeBinding(() => binaryResponse(MP3_BYTES, "audio/mpeg"));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.speech(AURA).doGenerate({
      outputFormat: "flac",
      text: "hi",
      voice: "luna"
    });

    expect(binding.calls[0].input).toEqual({
      encoding: "flac",
      speaker: "luna",
      text: "hi"
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns for an encoding Aura does not accept", async () => {
    const binding = fakeBinding(() => binaryResponse(MP3_BYTES, "audio/mpeg"));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai
      .speech(AURA)
      .doGenerate({ outputFormat: "ogg", text: "hi" });

    expect(binding.calls[0].input).toEqual({ text: "hi" });
    expect(result.warnings).toEqual([
      {
        details: "Expected one of linear16, flac, mulaw, alaw, mp3, opus, aac.",
        feature: "outputFormat",
        type: "unsupported"
      }
    ]);
  });

  it("uses melotts's own { prompt, lang } shape", async () => {
    const binding = fakeBinding(() => jsonResponse({ audio: "AAEC" }));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.speech(MELOTTS).doGenerate({
      language: "fr",
      speed: 1.5,
      text: "bonjour",
      voice: "luna"
    });

    expect(binding.calls[0].input).toEqual({ lang: "fr", prompt: "bonjour" });
    // Base64 stays base64: the AI SDK converts on demand.
    expect(result.audio).toBe("AAEC");
    const features = result.warnings.flatMap((warning) =>
      warning.type === "unsupported" ? [warning.feature] : []
    );
    expect(features).toEqual(["speed", "voice"]);
  });

  it("errors when the JSON answer carries no audio", async () => {
    const binding = fakeBinding(() => jsonResponse({ nope: true }));
    const ai = createAI({ binding: asAi(binding) });
    await expect(
      ai.speech(MELOTTS).doGenerate({ text: "hi" })
    ).rejects.toBeInstanceOf(CloudflareAIError);
  });

  it("works through generateSpeech and carries gateway metadata", async () => {
    const binding = fakeBinding(() => binaryResponse(MP3_BYTES, "audio/mpeg"));
    binding.aiGatewayLogId = "01M1KR5B6WPG8QJ2VK5C127BEG";
    const ai = createAI({ binding: asAi(binding) });
    const result = await generateSpeech({
      model: ai.speechModel(AURA),
      text: "Hello from Cloudflare"
    });

    expect(result.audio.uint8Array).toEqual(MP3_BYTES);
    expect(result.providerMetadata.cloudflare).toMatchObject({
      gateway: "default",
      logId: "01M1KR5B6WPG8QJ2VK5C127BEG",
      model: AURA
    });
  });
});

describe("transcription", () => {
  it("sends base64 audio to whisper and maps the answer", async () => {
    const binding = fakeBinding(() => jsonResponse(whisperBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.transcription(WHISPER).doGenerate({
      audio: new Uint8Array([0, 1, 2]),
      mediaType: "audio/mpeg"
    });

    expect(binding.calls[0].model).toBe(WHISPER);
    expect(binding.calls[0].input).toEqual({ audio: "AAEC" });
    expect(result.text).toBe("Hello from Cloudflare.");
    expect(result.language).toBe("en");
    expect(result.durationInSeconds).toBe(1.584);
    expect(result.segments).toEqual([
      { endSecond: 1.38, startSecond: 0, text: " Hello from Cloudflare." }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("passes base64 audio straight through", async () => {
    const binding = fakeBinding(() => jsonResponse(whisperBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai
      .transcription(WHISPER)
      .doGenerate({ audio: "AAEC", mediaType: "audio/mpeg" });

    expect(binding.calls[0].input).toEqual({ audio: "AAEC" });
  });

  it("sends a byte array to the older whisper ids", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        text: "Hello",
        words: [{ end: 0.5, start: 0, word: "Hello" }]
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.transcription(WHISPER_TINY).doGenerate({
      audio: new Uint8Array([0, 1, 2]),
      mediaType: "audio/mpeg"
    });

    expect(binding.calls[0].input).toEqual({ audio: [0, 1, 2] });
    // No `segments` in that answer: word timings are the boundaries we have.
    expect(result.segments).toEqual([
      { endSecond: 0.5, startSecond: 0, text: "Hello" }
    ]);
    expect(result.language).toBeUndefined();
    expect(result.durationInSeconds).toBeUndefined();
  });

  it("forwards the recognition knobs from providerOptions", async () => {
    const binding = fakeBinding(() => jsonResponse(whisperBody));
    const ai = createAI({ binding: asAi(binding) });
    await ai.transcription(WHISPER).doGenerate({
      audio: "AAEC",
      mediaType: "audio/mpeg",
      providerOptions: {
        cloudflare: {
          initialPrompt: "Cloudflare",
          language: "en",
          prefix: "Note:",
          task: "translate",
          vadFilter: true
        }
      }
    });

    expect(binding.calls[0].input).toEqual({
      audio: "AAEC",
      initial_prompt: "Cloudflare",
      language: "en",
      prefix: "Note:",
      task: "translate",
      vad_filter: true
    });
  });

  it("refuses Deepgram recognition models without calling the run path", async () => {
    const binding = fakeBinding(() => jsonResponse(whisperBody));
    const ai = createAI({ binding: asAi(binding) });
    const error = await Promise.resolve(
      ai
        .transcription("@cf/deepgram/nova-3")
        .doGenerate({ audio: "AAEC", mediaType: "audio/mpeg" })
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CloudflareAIError);
    expect((error as CloudflareAIError).message).toContain(
      "@cf/openai/whisper-large-v3-turbo"
    );
    expect(binding.calls).toHaveLength(0);
  });

  it("works through transcribe and unwraps the Cloudflare envelope", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        errors: [],
        messages: [],
        result: whisperBody,
        success: true
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await transcribe({
      audio: new Uint8Array([0, 1, 2]),
      model: ai.transcriptionModel(WHISPER)
    });

    expect(result.text).toBe("Hello from Cloudflare.");
    expect(result.segments).toHaveLength(1);
  });
});

describe("reranking", () => {
  it("sends { query, contexts, top_k } and sorts by score", async () => {
    const binding = fakeBinding(() => jsonResponse(rerankBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.reranking(RERANKER).doRerank({
      documents: { type: "text", values: ["a cyberpunk lizard", "a cat"] },
      query: "Which one is cooler?",
      topN: 2
    });

    expect(binding.calls[0].model).toBe(RERANKER);
    expect(binding.calls[0].input).toEqual({
      contexts: [{ text: "a cyberpunk lizard" }, { text: "a cat" }],
      query: "Which one is cooler?",
      top_k: 2
    });
    expect(result.ranking).toEqual([
      { index: 1, relevanceScore: 0.9544025659561157 },
      { index: 0, relevanceScore: 0.00003775554432650097 }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("re-sorts an answer that arrives out of order", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({
        response: [
          { id: 0, score: 0.1 },
          { id: 1, score: 0.9 }
        ]
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.reranking(RERANKER).doRerank({
      documents: { type: "text", values: ["a", "b"] },
      query: "q"
    });

    expect(result.ranking.map((row) => row.index)).toEqual([1, 0]);
    expect(binding.calls[0].input).not.toHaveProperty("top_k");
  });

  it("stringifies object documents and warns about it", async () => {
    const binding = fakeBinding(() =>
      jsonResponse({ response: [{ id: 0, score: 1 }] })
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.reranking(RERANKER).doRerank({
      documents: { type: "object", values: [{ title: "a" }] },
      query: "q"
    });

    expect(binding.calls[0].input).toEqual({
      contexts: [{ text: '{"title":"a"}' }],
      query: "q"
    });
    expect(result.warnings).toEqual([
      {
        details: "Object documents are sent as JSON text.",
        feature: "documents",
        type: "compatibility"
      }
    ]);
  });

  it("works through rerank", async () => {
    const binding = fakeBinding(() => jsonResponse(rerankBody));
    const ai = createAI({ binding: asAi(binding) });
    const result = await rerank({
      documents: ["a cyberpunk lizard", "a cat"],
      model: ai.rerankingModel(RERANKER),
      query: "Which one is cooler?"
    });

    expect(result.rerankedDocuments).toEqual(["a cat", "a cyberpunk lizard"]);
    expect(binding.calls[0].options.gateway).toMatchObject({ id: "default" });
  });
});

describe("modality options and fallback", () => {
  it("merges gateway options across the three layers", async () => {
    const binding = fakeBinding(() => jsonResponse(rerankBody));
    const ai = createAI({
      binding: asAi(binding),
      gateway: { id: "provider-gw", metadata: { app: "demo" } }
    });
    await ai.reranking(RERANKER, { cacheTtl: 90 }).doRerank({
      documents: { type: "text", values: ["a"] },
      providerOptions: { cloudflare: { skipCache: true } },
      query: "q"
    });

    expect(binding.calls[0].options.gateway).toEqual({
      cacheTtl: 90,
      id: "provider-gw",
      metadata: { app: "demo" },
      skipCache: true
    });
  });

  it("sends session affinity and per-call headers", async () => {
    const binding = fakeBinding(() => binaryResponse(MP3_BYTES, "audio/mpeg"));
    const ai = createAI({ binding: asAi(binding) });
    await ai.speech(AURA, { sessionAffinity: "s-1" }).doGenerate({
      headers: { "x-keep": "yes", "x-skip": undefined },
      text: "hi"
    });

    expect(binding.calls[0].options.extraHeaders).toEqual({
      "x-keep": "yes",
      "x-session-affinity": "s-1"
    });
  });

  it("falls back to another image model when the first fails", async () => {
    const binding = fakeBinding((call) =>
      call.model === FLUX
        ? jsonResponse(
            {
              error: [{ code: 3040, message: "Capacity exceeded" }],
              name: "AiGatewayError"
            },
            { status: 429 }
          )
        : binaryResponse(PNG_BYTES, "image/png")
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai.image(FLUX, { fallback: [SDXL] }).doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a fox",
      providerOptions: {},
      seed: undefined,
      size: undefined
    });

    expect(binding.calls.map((call) => call.model)).toEqual([FLUX, SDXL]);
    // The fallback leg rebuilds the body for its own model, so sdxl gets the
    // full shape even though flux only ever gets prompt and steps.
    expect(result.images[0]).toEqual(PNG_BYTES);
    // Image metadata is typed as `{ images } & JSONObject`, so the gateway
    // fields are read off it rather than declared on it.
    expect(field(result.providerMetadata?.cloudflare, "model")).toBe(SDXL);
  });

  it("exposes every modality under both names", () => {
    const binding = fakeBinding(() => jsonResponse({}));
    const ai = createAI({ binding: asAi(binding) });

    expect(ai.image(FLUX).modelId).toBe(FLUX);
    expect(ai.imageModel(FLUX).specificationVersion).toBe("v4");
    expect(ai.imageModel(FLUX).maxImagesPerCall).toBe(1);
    expect(ai.transcription(WHISPER).modelId).toBe(WHISPER);
    expect(ai.transcriptionModel(WHISPER).provider).toBe("cloudflare");
    expect(ai.speech(AURA).modelId).toBe(AURA);
    expect(ai.speechModel(AURA).specificationVersion).toBe("v4");
    expect(ai.reranking(RERANKER).modelId).toBe(RERANKER);
    expect(ai.rerankingModel(RERANKER).specificationVersion).toBe("v4");
  });
});

describe("modality models and string legs", () => {
  it("refuse a third-party id written as a per-model leg", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => jsonResponse({}))) });
    expect(() =>
      ai.embedding("@cf/baai/bge-base-en-v1.5", {
        fallback: ["openai/text-embedding-3-small" as never]
      })
    ).toThrow(TypeError);
    expect(() =>
      ai.image("@cf/black-forest-labs/flux-1-schnell", {
        fallback: ["openai/gpt-image-1" as never]
      })
    ).toThrow(TypeError);
    expect(() =>
      ai.embedding("@cf/baai/bge-base-en-v1.5", {
        fallback: ["@cf/baai/bge-small-en-v1.5"]
      })
    ).not.toThrow();
  });
});
