/**
 * `agents/webfetch/pi` — the `web_fetch` tool for the pi harness.
 *
 * @beta
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { MAX_WEB_FETCH_URL_LENGTH, type WebFetchToolOutput } from "../contract";
import type { WebFetchErrorCode } from "../source";
import { createWebFetchToolCore, type WebFetchToolOptions } from "../tool";

export type {
  WebFetchFormat,
  WebFetchPage,
  WebFetchToolInput,
  WebFetchToolOutput,
  WebFetchVia
} from "../contract";
export {
  WebFetchError,
  type WebFetchErrorCode,
  type WebFetchRequest,
  type WebFetchSource
} from "../source";
export type { WebFetchToolOptions } from "../tool";

/** The model's input schema. pi already coerces `"20000"` to `20000`. */
function webFetchParameters() {
  return Type.Object({
    url: Type.String({
      minLength: 1,
      maxLength: MAX_WEB_FETCH_URL_LENGTH,
      description: "The http(s) URL to read."
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Character offset into the content, to continue a long page from the previous result's offset. Default 0."
      })
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("raw")], {
        description:
          '"auto" (default) converts to the most readable form; "raw" returns the body as served.'
      })
    )
  });
}

type WebFetchParameters = ReturnType<typeof webFetchParameters>;

/**
 * Host-side details pi stores with each `web_fetch` result: the output (the
 * window the model read, with the page's metadata) or the failure.
 */
export type WebFetchToolDetails =
  | { ok: true; output: WebFetchToolOutput }
  | {
      ok: false;
      /** The source's error message, with the detail for the host. */
      message: string;
      status: number;
      code: WebFetchErrorCode;
      retryable: boolean;
      url?: string;
      /** The response's media type, when a response was read. */
      contentType?: string;
    };

/**
 * Create a pi tool that reads a URL as Markdown, JSON, or text. Install it
 * on a registry like any other pi tool.
 *
 * The model chooses the URL, the window (`offset`), and the format; the
 * host chooses the URL policy, size limits, and window size. The tool is
 * `replay: "safe"`: a fetch interrupted mid-call (say, by an eviction) runs
 * again when the session recovers. Completed results are stored and not
 * fetched again.
 *
 * @example
 * ```ts
 * import { createRegistry } from "@earendil-works/pi-durable";
 * import { webFetchTool } from "agents/webfetch/pi";
 *
 * const registry = createRegistry();
 * registry.install({
 *   name: "tools",
 *   tools: [webFetchTool({ binding: env.AI })]
 * });
 * ```
 */
export function webFetchTool(
  options: WebFetchToolOptions
): ToolRegistration<WebFetchParameters, WebFetchToolDetails> {
  const core = createWebFetchToolCore(options);
  return {
    name: core.name,
    description: core.description,
    parameters: webFetchParameters(),
    replay: "safe",
    async execute(input, _api, context) {
      const run = await core.run(input, { signal: context.abortSignal });
      if (run.ok) {
        return {
          content: [{ type: "text", text: run.text }],
          details: { ok: true, output: run.output }
        };
      }
      const details: WebFetchToolDetails = {
        ok: false,
        message: run.error.message,
        status: run.error.status,
        code: run.error.code,
        retryable: run.error.retryable
      };
      if (run.error.url !== undefined) details.url = run.error.url;
      if (run.error.contentType !== undefined) {
        details.contentType = run.error.contentType;
      }
      return {
        content: [{ type: "text", text: run.text }],
        isError: true,
        details
      };
    }
  };
}
