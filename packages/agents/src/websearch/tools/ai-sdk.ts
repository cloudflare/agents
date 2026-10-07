/**
 * `agents/websearch/ai-sdk` — the `web_search` tool for the AI SDK.
 *
 * @beta
 */
import type { FlexibleSchema } from "ai";
import type { WebSearchToolInput, WebSearchToolOutput } from "../contract";
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

/**
 * The part of the AI SDK's tool execution options the tool reads. Spelled
 * out rather than imported so it fits every supported `ai` major.
 */
export interface WebSearchToolExecuteOptions {
  abortSignal?: AbortSignal;
}

/**
 * The AI SDK tool {@link webSearchTool} returns. Assignable to the AI SDK's
 * `Tool`; `execute` and `toModelOutput` are always present.
 */
export interface WebSearchTool {
  description: string;
  inputSchema: FlexibleSchema<WebSearchToolInput>;
  execute(
    input: WebSearchToolInput,
    options: WebSearchToolExecuteOptions
  ): Promise<WebSearchToolOutput>;
  toModelOutput(options: { output: WebSearchToolOutput }): {
    type: "text";
    value: string;
  };
}

/**
 * Create an AI SDK tool that searches the web through Cloudflare's Web
 * Search API. The host gets the full response as the tool's output (whole
 * descriptions, provider metadata); the model gets a trimmed text rendering
 * via `toModelOutput`. A failed search throws a `WebSearchError`, which the
 * AI SDK reports to the model as a tool error: its `message` is written for
 * the model, and its `cause` is the source's error with the API's detail.
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
 *   tools: { web_search: webSearchTool({ binding: env.AI }) },
 *   messages
 * });
 * ```
 */
export function webSearchTool(options: WebSearchToolOptions): WebSearchTool {
  const core = createWebSearchToolCore(options);
  return {
    description: core.description,
    inputSchema: webSearchInputSchema(core.limit),
    async execute(input, { abortSignal }) {
      const run = await core.run(input, { signal: abortSignal });
      if (!run.ok) throw toolFailure(run);
      return run.output;
    },
    toModelOutput: ({ output }) => ({
      type: "text",
      value: core.render(output)
    })
  };
}
