/**
 * `agents/webfetch/tanstack-ai` — the `web_fetch` tool for TanStack AI.
 *
 * @beta
 */
import { toolDefinition } from "@tanstack/ai";
import type { WEB_FETCH_TOOL_NAME } from "../contract";
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

export type TanStackWebFetchToolOptions<
  TName extends string = typeof WEB_FETCH_TOOL_NAME
> = WebFetchToolOptions & {
  /** The tool's name. TanStack AI tools carry it in the definition. */
  name?: TName;
};

/**
 * Create a TanStack AI tool that reads a URL as Markdown, JSON, or text.
 * TanStack AI has one return channel, so the model and the host both get
 * the rendered window. A failed fetch throws a `WebFetchError`, which
 * TanStack AI reports as an error result: its `message` is written for the
 * model, and its `cause` is the source's error with the detail. The tool is
 * named `web_fetch` unless you pass `name`.
 *
 * @example
 * ```ts
 * import { webFetchTool } from "agents/webfetch/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * const stream = chat({
 *   adapter,
 *   tools: [webFetchTool({ binding: env.AI })],
 *   messages
 * });
 * ```
 */
export function webFetchTool<TName extends string = typeof WEB_FETCH_TOOL_NAME>(
  options: TanStackWebFetchToolOptions<TName>
) {
  const core = createWebFetchToolCore(options);
  return toolDefinition({
    name: options.name ?? (core.name as TName),
    description: core.description,
    inputSchema: webFetchInputSchema()
  }).server(async (input, context) => {
    const run = await core.run(input, { signal: context?.abortSignal });
    if (!run.ok) throw toolFailure(run);
    return run.text;
  });
}
