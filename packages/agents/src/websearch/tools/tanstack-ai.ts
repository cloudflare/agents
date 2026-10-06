/**
 * `agents/websearch/tanstack-ai` — the `websearch` tool for TanStack AI.
 *
 * @beta
 */
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { MAX_WEBSEARCH_QUERY_LENGTH } from "../contract";
import {
  createWebSearchToolCore,
  toolFailure,
  type WebSearchToolOptions
} from "../tool";

export type {
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput
} from "../contract";
export type { WebSearchProvider, WebSearchSource } from "../source";
export type { WebSearchToolOptions } from "../tool";

export type TanStackWebSearchToolOptions<TName extends string = "websearch"> =
  WebSearchToolOptions & {
    /** The tool's name. TanStack AI tools carry it in the definition. */
    name?: TName;
  };

/** The model's input schema; `limit` tops out at the host's cap. */
function webSearchInputSchema(maxLimit: number) {
  return z.object({
    query: z
      .string()
      .min(1)
      .max(MAX_WEBSEARCH_QUERY_LENGTH)
      .describe("What to search for."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .optional()
      .describe(`How many results to return (at most ${maxLimit}).`)
  });
}

/**
 * Create a TanStack AI tool that searches the web through Cloudflare's Web
 * Search API. TanStack AI has one return channel, so the model and the host
 * both get the trimmed text rendering. A failed search throws a
 * `WebSearchError`, which TanStack AI reports as an error result: its
 * `message` is written for the model, and its `cause` is the source's error
 * with the API's detail. The tool is named `websearch` unless you pass
 * `name`.
 *
 * @example
 * ```ts
 * import { webSearchTool } from "agents/websearch/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * const stream = chat({
 *   adapter,
 *   tools: [webSearchTool({ binding: env.AI })],
 *   messages
 * });
 * ```
 */
export function webSearchTool<TName extends string = "websearch">(
  options: TanStackWebSearchToolOptions<TName>
) {
  const core = createWebSearchToolCore(options);
  return toolDefinition({
    name: options.name ?? (core.name as TName),
    description: core.description,
    inputSchema: webSearchInputSchema(core.limit)
  }).server(async (input, context) => {
    const run = await core.run(input, { signal: context?.abortSignal });
    if (!run.ok) throw toolFailure(run);
    return run.text;
  });
}
