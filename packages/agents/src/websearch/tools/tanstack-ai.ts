/**
 * `agents/websearch/tanstack-ai` — the `web_search` tool for TanStack AI.
 *
 * @beta
 */
import { toolDefinition } from "@tanstack/ai";
import type { WEBSEARCH_TOOL_NAME } from "../contract";
import {
  createWebSearchToolCore,
  toolFailure,
  type WebSearchToolOptions
} from "../tool";
import { webSearchInputSchema } from "./input-schema";

export type {
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput
} from "../contract";
export {
  WebSearchError,
  type WebSearchErrorCode,
  type WebSearchProvider,
  type WebSearchSource
} from "../source";
export type { WebSearchToolOptions } from "../tool";

export type TanStackWebSearchToolOptions<
  TName extends string = typeof WEBSEARCH_TOOL_NAME
> = WebSearchToolOptions & {
  /** The tool's name. TanStack AI tools carry it in the definition. */
  name?: TName;
};

/**
 * Create a TanStack AI tool that searches the web through Cloudflare's Web
 * Search API. TanStack AI has one return channel, so the model and the host
 * both get the trimmed text rendering. A failed search throws a
 * `WebSearchError`, which TanStack AI reports as an error result: its
 * `message` is written for the model, and its `cause` is the source's error
 * with the API's detail. The tool is named `web_search` unless you pass
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
export function webSearchTool<
  TName extends string = typeof WEBSEARCH_TOOL_NAME
>(options: TanStackWebSearchToolOptions<TName>) {
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
