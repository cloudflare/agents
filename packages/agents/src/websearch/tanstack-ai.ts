/**
 * `agents/websearch/tanstack-ai` — the `websearch` tool for TanStack AI.
 *
 * @beta
 */
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { MAX_WEBSEARCH_LIMIT } from "./contract";
import { createWebSearchToolCore, type WebSearchToolOptions } from "./tool";

export type {
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput
} from "./contract";
export type { WebSearchProvider, WebSearchSource } from "./source";
export type { WebSearchToolOptions } from "./tool";

export type TanStackWebSearchToolOptions<TName extends string = "websearch"> =
  WebSearchToolOptions & {
    /** The tool's name. TanStack AI tools carry it in the definition. */
    name?: TName;
  };

const inputSchema = z.object({
  query: z.string().min(1).max(1024).describe("What to search for."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_WEBSEARCH_LIMIT)
    .optional()
    .describe("How many results to return.")
});

/**
 * Create a TanStack AI tool that searches the web through Cloudflare's Web
 * Search API. TanStack AI has one return channel, so the model and the host
 * both get the trimmed text rendering. The tool is named `websearch` unless
 * you pass `name`.
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
    inputSchema
  }).server(async (input) => (await core.run(input)).text);
}
