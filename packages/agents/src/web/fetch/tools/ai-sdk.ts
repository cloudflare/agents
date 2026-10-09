/**
 * `agents/webfetch/ai-sdk` — the `web_fetch` tool for the AI SDK.
 *
 * @beta
 */
import type { FlexibleSchema } from "ai";
import type { WebFetchToolInput, WebFetchToolOutput } from "../contract";
import {
  createWebFetchToolCore,
  toolFailure,
  type WebFetchToolOptions
} from "../tool";
import { webFetchInputSchema } from "./input-schema";

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

/**
 * The part of the AI SDK's tool execution options the tool reads. Spelled
 * out rather than imported so it fits every supported `ai` major.
 */
export interface WebFetchToolExecuteOptions {
  abortSignal?: AbortSignal;
}

/**
 * The AI SDK tool {@link webFetchTool} returns. Assignable to the AI SDK's
 * `Tool`; `execute` and `toModelOutput` are always present.
 */
export interface WebFetchTool {
  description: string;
  inputSchema: FlexibleSchema<WebFetchToolInput>;
  execute(
    input: WebFetchToolInput,
    options: WebFetchToolExecuteOptions
  ): Promise<WebFetchToolOutput>;
  toModelOutput(options: { output: WebFetchToolOutput }): {
    type: "text";
    value: string;
  };
}

/**
 * Create an AI SDK tool that reads a URL as Markdown, JSON, or text. The
 * tool's output is the window the model read plus the page's metadata
 * (status, headers, redirects, total length), so it stays small in stored
 * messages; `toModelOutput` renders it for the model. A failed fetch throws a `WebFetchError`, which
 * the AI SDK reports to the model as a tool error: its `message` is written
 * for the model, and its `cause` is the source's error with the detail.
 *
 * `toModelOutput` only applies to earlier turns when the tools are passed to
 * `convertToModelMessages(messages, { tools })`; otherwise the AI SDK sends
 * the output back to the model as JSON, without the header or the
 * untrusted-content wrapper. `ThinkHarness` passes them.
 *
 * @example
 * ```ts
 * import { webFetchTool } from "agents/webfetch/ai-sdk";
 *
 * const result = streamText({
 *   model,
 *   tools: { web_fetch: webFetchTool({ binding: env.AI }) },
 *   messages
 * });
 * ```
 */
export function webFetchTool(options: WebFetchToolOptions): WebFetchTool {
  const core = createWebFetchToolCore(options);
  return {
    description: core.description,
    inputSchema: webFetchInputSchema(),
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
