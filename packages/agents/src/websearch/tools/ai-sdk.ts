/**
 * `agents/websearch/ai-sdk` — the `websearch` tool for the AI SDK.
 *
 * @beta
 */
import type { FlexibleSchema } from "ai";
import { z } from "zod";
import {
  MAX_WEBSEARCH_QUERY_LENGTH,
  renderWebSearchResults,
  type WebSearchToolInput,
  type WebSearchToolOutput
} from "../contract";
import { createWebSearchToolCore, type WebSearchToolOptions } from "../tool";

export type {
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput
} from "../contract";
export type { WebSearchProvider, WebSearchSource } from "../source";
export type { WebSearchToolOptions } from "../tool";

/**
 * The AI SDK tool {@link webSearchTool} returns. Assignable to the AI SDK's
 * `Tool`; `execute` and `toModelOutput` are always present.
 */
export interface WebSearchTool {
  description: string;
  inputSchema: FlexibleSchema<WebSearchToolInput>;
  execute(
    input: WebSearchToolInput,
    options: unknown
  ): Promise<WebSearchToolOutput>;
  toModelOutput(options: { output: WebSearchToolOutput }): {
    type: "text";
    value: string;
  };
}

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
 * Create an AI SDK tool that searches the web through Cloudflare's Web
 * Search API. The host gets the full response as the tool's output (whole
 * descriptions, provider metadata); the model gets a trimmed text rendering
 * via `toModelOutput`. A failed search throws a `WebSearchError`, which the
 * AI SDK reports to the model as a tool error.
 *
 * `toModelOutput` only applies to earlier turns when the tools are passed to
 * `convertToModelMessages(messages, { tools })`; otherwise the AI SDK sends
 * the full response back to the model as JSON. `AiSdkHarness` passes them.
 *
 * @example
 * ```ts
 * import { webSearchTool } from "agents/websearch/ai-sdk";
 *
 * const result = streamText({
 *   model,
 *   tools: { websearch: webSearchTool({ binding: env.AI }) },
 *   messages
 * });
 * ```
 */
export function webSearchTool(options: WebSearchToolOptions): WebSearchTool {
  const core = createWebSearchToolCore(options);
  const render = { maxDescriptionChars: options.maxDescriptionChars };
  return {
    description: core.description,
    inputSchema: webSearchInputSchema(core.limit),
    async execute(input) {
      const run = await core.run(input);
      if (!run.ok) throw run.error;
      return run.output;
    },
    toModelOutput: ({ output }) => ({
      type: "text",
      value: renderWebSearchResults(output, render)
    })
  };
}
