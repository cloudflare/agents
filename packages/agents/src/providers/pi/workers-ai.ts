import {
  createModels,
  createProvider,
  type ApiStreamOptions,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions
} from "pi-ai-dev";
import { openAICompletionsApi } from "pi-ai-dev/api/openai-completions.lazy";
import type { PiModel, PiModels } from "../../harness/types";

const PROVIDER_ID = "cloudflare-workers-ai-binding";
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

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

/** Options for creating a pi model runtime over a Workers AI binding. */
export type WorkersAIOptions = {
  /** Workers AI model slug. @default "@cf/moonshotai/kimi-k2.7-code" */
  readonly model?: string;
  /** AI Gateway ID used for the binding call. */
  readonly gateway?: string;
  /** Model context-window metadata used by pi compaction. @default 128000 */
  readonly contextWindow?: number;
  /** Maximum output tokens requested by pi. @default 16384 */
  readonly maxTokens?: number;
  /** Whether pi exposes thinking-level controls. @default true */
  readonly reasoning?: boolean;
  /**
   * Require replayed assistant messages to carry `reasoning_content`.
   * Defaults to true for GPT-OSS models and false for other Workers AI models.
   */
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
};

/** Pi model registry and selected model backed by Workers AI. */
export type WorkersAIRuntime = {
  readonly models: PiModels;
  readonly model: PiModel;
};

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  throw new TypeError("Workers AI pi requests require a JSON request body");
}

/**
 * Create pi's model registry over a Cloudflare Workers AI binding.
 *
 * The adapter uses Workers AI's OpenAI-compatible raw response and sends it
 * through pi's own streaming parser, including tool calls and usage.
 */
export function createWorkersAI(
  binding: Ai,
  options: WorkersAIOptions = {}
): WorkersAIRuntime {
  const modelSlug = options.model ?? DEFAULT_MODEL;
  // SAFETY: Workers AI returns a Response when `returnRawResponse` is true.
  // The public `Ai` overload cannot preserve that correlation structurally.
  const runBinding = binding as unknown as RunBinding;
  const fetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const input = JSON.parse(bodyText(init?.body)) as Record<string, unknown>;
    delete input.model;
    return runBinding.run(modelSlug, input, {
      ...(options.gateway ? { gateway: { id: options.gateway } } : {}),
      returnRawResponse: true,
      ...(init?.signal ? { signal: init.signal } : {})
    });
  };

  const model: Model<"openai-completions"> = {
    id: modelSlug,
    name: modelSlug,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: "https://workers-ai.binding.invalid/v1",
    reasoning: options.reasoning ?? true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
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
        options.requiresReasoningContentOnAssistantMessages ??
        modelSlug.includes("gpt-oss"),
      thinkingFormat: "openai"
    }
  };
  const api = openAICompletionsApi();
  const streams: ProviderStreams = {
    stream: (requestModel, context, streamOptions) =>
      api.stream(requestModel, context, {
        ...streamOptions,
        fetch
      } as ApiStreamOptions<string>),
    streamSimple: (
      requestModel: Model<string>,
      context: Context,
      streamOptions?: SimpleStreamOptions
    ) =>
      api.streamSimple(requestModel, context, {
        ...streamOptions,
        fetch
      })
  };
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Cloudflare Workers AI binding",
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
    models: [model],
    api: streams
  });
  const models = createModels({
    authContext: {
      env: async () => undefined,
      fileExists: async () => false
    }
  });
  models.setProvider(provider);
  return { models, model };
}
