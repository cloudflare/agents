/**
 * The harness-neutral core of the `websearch` tool, shared by the pi
 * (`agents/websearch/pi`), AI SDK (`agents/websearch/ai-sdk`), and TanStack
 * AI (`agents/websearch/tanstack-ai`) adapters. Internal — not an entry point.
 */
import {
  DEFAULT_WEBSEARCH_LIMIT,
  MAX_WEBSEARCH_LIMIT,
  WEBSEARCH_TOOL_DESCRIPTION,
  WEBSEARCH_TOOL_NAME,
  renderWebSearchResults,
  type WebSearchToolInput,
  type WebSearchToolOutput
} from "./contract";
import {
  WebSearchError,
  createAIWebSearch,
  type AIWebSearchOptions,
  type WebSearchSource
} from "./source";

/** Search through the Workers AI binding; the tool builds the source. */
export type WebSearchToolBindingOptions = AIWebSearchOptions & {
  source?: never;
};

/**
 * Search through a source you built. Gateway, provider, and billing belong
 * to the source, so the binding options are not accepted here.
 */
export type WebSearchToolSourceOptions = {
  /** Where searches run, instead of the Workers AI binding. */
  source: WebSearchSource;
  binding?: never;
  gateway?: never;
  provider?: never;
  byokAlias?: never;
};

/** Options every `websearch` tool adapter accepts. */
export type WebSearchToolOptions = (
  | WebSearchToolBindingOptions
  | WebSearchToolSourceOptions
) & {
  /**
   * Results per search when the model doesn't ask for a count, and the most
   * it may ask for. 1–10; defaults to 5.
   */
  limit?: number;
  /** Replaces the default tool description. */
  description?: string;
  /**
   * Per-result description length in the model's view. Defaults to 600
   * characters; `Infinity` passes descriptions through whole.
   */
  maxDescriptionChars?: number;
};

/** What one run returns to the adapter: the host output, and the model's text. */
export type WebSearchToolRun =
  | { ok: true; output: WebSearchToolOutput; text: string }
  | { ok: false; error: WebSearchError; text: string };

export interface WebSearchToolCore {
  name: typeof WEBSEARCH_TOOL_NAME;
  description: string;
  /** The host's `limit`: the default and the cap for the model's `limit`. */
  limit: number;
  run(input: WebSearchToolInput): Promise<WebSearchToolRun>;
}

export function createWebSearchToolCore(
  options: WebSearchToolOptions
): WebSearchToolCore {
  const limit = clampLimit(options.limit ?? DEFAULT_WEBSEARCH_LIMIT);
  const source =
    options.source === undefined ? createAIWebSearch(options) : options.source;
  const provider = source.provider;
  const render = { maxDescriptionChars: options.maxDescriptionChars };

  return {
    name: WEBSEARCH_TOOL_NAME,
    description: options.description ?? WEBSEARCH_TOOL_DESCRIPTION,
    limit,
    async run(input) {
      const request = {
        query: input.query,
        limit: Math.min(clampLimit(input.limit ?? limit), limit)
      };
      try {
        const response = await source(request);
        const output: WebSearchToolOutput = provider
          ? { ...response, provider }
          : response;
        return {
          ok: true,
          output,
          text: renderWebSearchResults(response, render)
        };
      } catch (cause) {
        const error =
          cause instanceof WebSearchError
            ? cause
            : new WebSearchError(
                cause instanceof Error ? cause.message : String(cause),
                { status: 500, retryable: true }
              );
        return {
          ok: false,
          error,
          text: `Web search failed: ${error.message}`
        };
      }
    }
  };
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WEBSEARCH_LIMIT;
  return Math.min(MAX_WEBSEARCH_LIMIT, Math.max(1, Math.trunc(value)));
}
