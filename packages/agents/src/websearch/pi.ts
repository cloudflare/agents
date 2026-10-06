/**
 * `agents/websearch/pi` — the `websearch` tool for the pi harness.
 *
 * @beta
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { MAX_WEBSEARCH_LIMIT, type WebSearchToolOutput } from "./contract";
import { createWebSearchToolCore, type WebSearchToolOptions } from "./tool";

export type {
  WebSearchResponse,
  WebSearchResult,
  WebSearchToolInput,
  WebSearchToolOutput
} from "./contract";
export type { WebSearchProvider, WebSearchSource } from "./source";
export type { WebSearchToolOptions } from "./tool";

const parameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: "What to search for."
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_WEBSEARCH_LIMIT,
      description: "How many results to return."
    })
  )
});

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
 * results; the host chooses the gateway, provider, and billing. Results are
 * replay-safe: a resumed session reuses stored results rather than searching
 * again.
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
): ToolRegistration<typeof parameters, WebSearchToolDetails> {
  const core = createWebSearchToolCore(options);
  return {
    name: core.name,
    description: core.description,
    parameters,
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
