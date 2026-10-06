/**
 * `agents/websearch/pi` — the `websearch` tool for the pi harness.
 *
 * @beta
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  MAX_WEBSEARCH_QUERY_LENGTH,
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

/** The model's input schema; `limit` tops out at the host's cap. */
function webSearchParameters(maxLimit: number) {
  return Type.Object({
    query: Type.String({
      minLength: 1,
      maxLength: MAX_WEBSEARCH_QUERY_LENGTH,
      description: "What to search for."
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: maxLimit,
        description: `How many results to return (at most ${maxLimit}).`
      })
    )
  });
}

type WebSearchParameters = ReturnType<typeof webSearchParameters>;

/**
 * Host-side details pi stores with each `websearch` result: the full API
 * response (untrimmed descriptions, provider metadata) or the failure.
 */
export type WebSearchToolDetails =
  | { ok: true; output: WebSearchToolOutput }
  | {
      ok: false;
      status: number;
      code?: string;
      retryable: boolean;
      requestId?: string;
    };

/**
 * Create a pi tool that searches the web through Cloudflare's Web Search
 * API. Install it on a registry like any other pi tool.
 *
 * The model chooses the query and (within the host's `limit`) how many
 * results; the host chooses the gateway, provider, and billing. The tool is
 * `replay: "safe"`: a search interrupted mid-call (say, by an eviction) runs
 * again when the session recovers, which is a second billed search.
 * Completed results are stored and not searched again.
 *
 * @example
 * ```ts
 * import { createRegistry } from "@earendil-works/pi-durable";
 * import { webSearchTool } from "agents/websearch/pi";
 *
 * const registry = createRegistry();
 * registry.install({
 *   name: "tools",
 *   tools: [webSearchTool({ binding: env.AI, provider: "exa" })]
 * });
 * ```
 */
export function webSearchTool(
  options: WebSearchToolOptions
): ToolRegistration<WebSearchParameters, WebSearchToolDetails> {
  const core = createWebSearchToolCore(options);
  return {
    name: core.name,
    description: core.description,
    parameters: webSearchParameters(core.limit),
    replay: "safe",
    async execute(input) {
      const run = await core.run(input);
      if (run.ok) {
        return {
          content: [{ type: "text", text: run.text }],
          details: { ok: true, output: run.output }
        };
      }
      return {
        content: [{ type: "text", text: run.text }],
        isError: true,
        details: {
          ok: false,
          status: run.error.status,
          code: run.error.code,
          retryable: run.error.retryable,
          requestId: run.error.requestId
        }
      };
    }
  };
}
