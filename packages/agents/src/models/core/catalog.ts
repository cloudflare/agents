/**
 * Keys of the ambient `AiModels` interface (from `@cloudflare/workers-types`)
 * whose model type extends `T`. Kept in step with the installed workers-types
 * version rather than hand-maintained here.
 */
type WorkersAIModelIdsExtending<T> = {
  [K in keyof AiModels]: AiModels[K] extends T ? K : never;
}[keyof AiModels];

/** The `inputs` shape a catalog entry declares. */
type InputsOf<K extends keyof AiModels> = AiModels[K] extends {
  inputs: infer I;
}
  ? I
  : never;

/** The `postProcessedOutputs` shape a catalog entry declares. */
type OutputsOf<K extends keyof AiModels> = AiModels[K] extends {
  postProcessedOutputs: infer O;
}
  ? O
  : never;

/**
 * Catalog keys whose input takes a required `messages` array — every current
 * chat model. Newer entries get their own generated class rather than
 * extending `BaseAiTextGeneration`, so the base-class arm alone misses them.
 */
type ChatCatalogId = {
  [K in keyof AiModels]: Extract<
    InputsOf<K>,
    { messages: unknown }
  > extends never
    ? never
    : K;
}[keyof AiModels];

/**
 * Catalog keys that take text and answer with embedding vectors. Both halves
 * matter: the input test alone also matches translation, classification and
 * speech models, which take `text` but return something else entirely.
 */
type EmbeddingCatalogId = {
  [K in keyof AiModels]: Extract<InputsOf<K>, { text: unknown }> extends never
    ? never
    : Extract<OutputsOf<K>, { data?: number[][] }> extends never
      ? never
      : K;
}[keyof AiModels];

/**
 * Catalog keys that take audio to transcribe. The `audio` key is required on
 * every speech-recognition input and on no other input shape, so the test is
 * exact rather than heuristic.
 */
type TranscriptionCatalogId = {
  [K in keyof AiModels]: Extract<InputsOf<K>, { audio: unknown }> extends never
    ? never
    : K;
}[keyof AiModels];

/**
 * Catalog keys that score a list of contexts against a query — rerankers.
 * `contexts` is required on exactly those inputs.
 */
type RerankingCatalogId = {
  [K in keyof AiModels]: Extract<
    InputsOf<K>,
    { contexts: unknown }
  > extends never
    ? never
    : K;
}[keyof AiModels];

/**
 * A Workers AI model id.
 *
 * Workers AI is the one catalog this package keeps up with, so this is the
 * only id shape it accepts: `@cf/<author>/<model>`. Autocomplete covers the
 * text-generation catalog from the installed `@cloudflare/workers-types`; the
 * template arm keeps every other `@cf/` slug assignable, because the catalog
 * lives server-side and moves independently of these types.
 *
 * Third-party models are not ids here — they are model objects built by their
 * own provider package and routed through AI Gateway.
 *
 * @experimental This surface is experimental and may change.
 */
export type WorkersAIModelId =
  // `Extract` is the runtime guard written as a type: the ambient catalog also
  // lists `@hf/...` ids, which `ai()` rejects, so they must not be suggested.
  | Extract<
      | ChatCatalogId
      | Exclude<
          WorkersAIModelIdsExtending<BaseAiTextGeneration>,
          WorkersAIModelIdsExtending<BaseAiTextToImage>
        >,
      `@cf/${string}`
    >
  // `& {}` keeps the literal arms out of the template's shadow: without it
  // TypeScript reduces every suggested id into `@cf/${string}` and stops
  // autocompleting them, exactly as `(string & {})` does elsewhere here.
  | (`@cf/${string}` & {});

/**
 * A text-embedding model id accepted by `ai.embedding()`.
 *
 * The modality methods are Workers AI only — there is no vendor route for them
 * — so, like {@link WorkersAIModelId}, they take `@cf/` ids and nothing else.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareEmbeddingModelId =
  | Extract<
      EmbeddingCatalogId | WorkersAIModelIdsExtending<BaseAiTextEmbeddings>,
      `@cf/${string}`
    >
  | (`@cf/${string}` & {});

/**
 * Workers AI text-to-image ids that the generated `AiModels` entries do not
 * classify as {@link BaseAiTextToImage} — the newer partner models get their
 * own generated class instead. Curated for autocomplete only; the catalog
 * lives server-side and any slug is accepted.
 *
 * The FLUX.2 family (`flux-2-dev`, `flux-2-klein-4b`, `flux-2-klein-9b`) is
 * deliberately absent, for the reason {@link UnsupportedTranscriptionId}
 * records for the Deepgram recognisers: its generated input takes a required
 * `multipart` object body (`{ multipart: { body, contentType } }`) and no
 * `prompt`, which the JSON run path cannot carry — live, the run path answers
 * `400 Bad input: required properties at "/" are 'multipart'`. Suggesting an
 * id that always 400s is worse than not suggesting it.
 *
 * @experimental This surface is experimental and may change.
 */
export type KnownImageModelId =
  | "@cf/black-forest-labs/flux-1-schnell"
  | "@cf/leonardo/lucid-origin"
  | "@cf/leonardo/phoenix-1.0";

/**
 * An image model id accepted by `ai.image()`.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareImageModelId =
  | Extract<
      WorkersAIModelIdsExtending<BaseAiTextToImage> | KnownImageModelId,
      `@cf/${string}`
    >
  | (`@cf/${string}` & {});

/**
 * Workers AI text-to-speech ids without a {@link BaseAiTextToSpeech} entry.
 * Curated for autocomplete only.
 *
 * @experimental This surface is experimental and may change.
 */
export type KnownSpeechModelId =
  | "@cf/deepgram/aura-1"
  | "@cf/deepgram/aura-2-en"
  | "@cf/deepgram/aura-2-es";

/**
 * A text-to-speech model id accepted by `ai.speech()`.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareSpeechModelId =
  | Extract<
      WorkersAIModelIdsExtending<BaseAiTextToSpeech> | KnownSpeechModelId,
      `@cf/${string}`
    >
  | (`@cf/${string}` & {});

/**
 * Deepgram's recognition models want the audio as an object body
 * (`audio: { body, contentType }`) rather than as base64, which the JSON run
 * path cannot carry — every documented variant answered `400` live. They stay
 * out of the suggested arm, and the transcription model answers a clear error
 * for them.
 */
type UnsupportedTranscriptionId = "@cf/deepgram/nova-3" | "@cf/deepgram/flux";

/**
 * A speech-recognition model id accepted by `ai.transcription()`.
 *
 * Deepgram's recognition models (`@cf/deepgram/nova-3`, `@cf/deepgram/flux`)
 * are deliberately not suggested: the run path rejects their documented input
 * shape, so this provider answers a clear error for them rather than a 400.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareTranscriptionModelId =
  | Extract<
      | Exclude<TranscriptionCatalogId, UnsupportedTranscriptionId>
      | Exclude<
          WorkersAIModelIdsExtending<BaseAiAutomaticSpeechRecognition>,
          UnsupportedTranscriptionId
        >,
      `@cf/${string}`
    >
  | (`@cf/${string}` & {});

/**
 * A reranking model id accepted by `ai.reranking()`.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareRerankingModelId =
  | Extract<RerankingCatalogId, `@cf/${string}`>
  | (`@cf/${string}` & {});

/** `true` when `Id` is in the literal (autocompleted) arm of `T`. */
type Suggests<T, Id extends string> =
  Extract<T, Id> extends never ? false : true;

/**
 * Compile-time guard: the repo-standard models must stay in the literal arms,
 * so a `@cloudflare/workers-types` bump that reshapes the catalog cannot
 * silently drop them into the `(string & {})` arm and stop suggesting them.
 * `tsc` fails on this alias if any of them stops being autocompleted.
 *
 * @internal
 */
export type CatalogAutocompleteCheck<
  T extends [true, true, true, true, true, true, true, true, true] = [
    Suggests<WorkersAIModelId, "@cf/zai-org/glm-4.7-flash">,
    Suggests<WorkersAIModelId, "@cf/meta/llama-3.3-70b-instruct-fp8-fast">,
    Suggests<CloudflareEmbeddingModelId, "@cf/baai/bge-base-en-v1.5">,
    Suggests<CloudflareEmbeddingModelId, "@cf/google/embeddinggemma-300m">,
    Suggests<CloudflareImageModelId, "@cf/black-forest-labs/flux-1-schnell">,
    Suggests<
      CloudflareImageModelId,
      "@cf/stabilityai/stable-diffusion-xl-base-1.0"
    >,
    Suggests<CloudflareSpeechModelId, "@cf/deepgram/aura-1">,
    Suggests<
      CloudflareTranscriptionModelId,
      "@cf/openai/whisper-large-v3-turbo"
    >,
    Suggests<CloudflareRerankingModelId, "@cf/baai/bge-reranker-base">
  ]
> = T;
