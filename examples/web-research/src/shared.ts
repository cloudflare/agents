import type { UIDataTypes, UIMessage } from "ai";
import type { WebSearchToolInput, WebSearchToolOutput } from "agents/websearch";

/**
 * How much of each result's description the model reads. The server passes
 * it to the tool; the client uses it to show exactly what the model saw.
 */
export const MAX_DESCRIPTION_CHARS = 600;

/** Chat messages with the `web_search` tool's input and output typed. */
export type ResearchMessage = UIMessage<
  unknown,
  UIDataTypes,
  { web_search: { input: WebSearchToolInput; output: WebSearchToolOutput } }
>;
