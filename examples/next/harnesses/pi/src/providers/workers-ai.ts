import {
  createProvider,
  type ApiStreamOptions,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import type { PiProvider } from "./models";

/** Provider id shared with pi-ai's REST-based Workers AI provider. */
export const WORKERS_AI_PROVIDER = "cloudflare-workers-ai";

type RunBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options: {
      gateway?: { id: string };
      returnRawResponse: true;
      signal?: AbortSignal;
    }
  ): Promise<Response>;
};

/** A Workers AI model missing from pi's catalog. */
export type WorkersAIModelOptions = {
  /** Workers AI model slug, for example `@cf/meta/llama-4-scout-17b-16e-instruct`. */
  readonly id: string;
  readonly name?: string;
  /** @default 128000 */
  readonly contextWindow?: number;
  /** @default 16384 */
  readonly maxTokens?: number;
  /** Whether pi exposes thinking-level controls. @default false */
  readonly reasoning?: boolean;
};

/** Options for {@link workersAI}. */
export type WorkersAIOptions = {
  /** AI Gateway id applied to every binding call. */
  readonly gateway?: string;
  /** Models to add to pi's Workers AI catalog. */
  readonly models?: readonly WorkersAIModelOptions[];
};

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  throw new TypeError("Workers AI pi requests require a JSON request body");
}

function customModel(
  options: WorkersAIModelOptions
): Model<"openai-completions"> {
  return {
    id: options.id,
    name: options.name ?? options.id,
    api: "openai-completions",
    provider: WORKERS_AI_PROVIDER,
    baseUrl: "https://workers-ai.binding.invalid/v1",
    reasoning: options.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? 128_000,
    maxTokens: options.maxTokens ?? 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages:
        options.id.includes("gpt-oss"),
      thinkingFormat: "openai"
    }
  };
}

/**
 * Pi's Workers AI provider served through a Workers AI binding.
 *
 * The catalog, request shaping, and streaming parser are pi-ai's own; only the
 * transport changes: instead of the REST endpoint with an API token, requests
 * go through `binding.run(model, body, { returnRawResponse: true })`, so no
 * credentials are needed and AI Gateway attaches by id. Register it with
 * {@link createModels} and select models by
 * `{ provider: "cloudflare-workers-ai", modelId: "@cf/..." }`.
 */
export function workersAI(
  binding: Ai,
  options: WorkersAIOptions = {}
): PiProvider {
  // SAFETY: Workers AI returns a Response when `returnRawResponse` is true.
  // The public `Ai` overload cannot preserve that correlation structurally.
  const runBinding = binding as unknown as RunBinding;
  const fetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const input = JSON.parse(bodyText(init?.body)) as Record<string, unknown>;
    const model = typeof input.model === "string" ? input.model : undefined;
    if (!model)
      throw new TypeError("Workers AI pi request is missing its model");
    delete input.model;
    return runBinding.run(model, input, {
      ...(options.gateway ? { gateway: { id: options.gateway } } : {}),
      returnRawResponse: true,
      ...(init?.signal ? { signal: init.signal } : {})
    });
  };

  const api = openAICompletionsApi();
  const streams: ProviderStreams = {
    stream: (model, context, streamOptions) =>
      api.stream(model, context, {
        ...streamOptions,
        fetch
      } as ApiStreamOptions<string>),
    streamSimple: (
      model: Model<string>,
      context: Context,
      streamOptions?: SimpleStreamOptions
    ) => api.streamSimple(model, context, { ...streamOptions, fetch })
  };

  const catalog = cloudflareWorkersAIProvider().getModels();
  const extra = (options.models ?? []).map(customModel);
  return createProvider({
    id: WORKERS_AI_PROVIDER,
    name: "Cloudflare Workers AI",
    auth: {
      apiKey: {
        name: "Workers AI binding",
        check: async () => ({
          type: "api_key" as const,
          source: "Workers AI binding"
        }),
        resolve: async () => ({
          auth: { apiKey: "workers-ai-binding" },
          source: "Workers AI binding"
        })
      }
    },
    models: [
      ...catalog.filter(
        (model) => !extra.some((added) => added.id === model.id)
      ),
      ...extra
    ],
    api: streams
  });
}
