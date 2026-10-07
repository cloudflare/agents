import type { UIDataTypes, UIMessage } from "ai";
import {
  MAX_WEB_SEARCH_LIMIT,
  type WebSearchProvider,
  type WebSearchToolInput,
  type WebSearchToolOutput
} from "agents/websearch";

/** The Workers AI model the agent runs on. */
export const MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813";

/**
 * How much of each result's description the model reads. The server passes
 * it to the tool; the client uses it to show exactly what the model saw.
 */
export const MAX_DESCRIPTION_CHARS = 600;

export const PROVIDERS = [
  "ceramic",
  "exa",
  "linkup"
] as const satisfies readonly WebSearchProvider[];

/**
 * The search settings you can change from the UI. They live in the agent's
 * state, so they persist and stay in sync across tabs.
 */
export interface ResearchSettings {
  /** Which search provider the AI Gateway calls. */
  provider: WebSearchProvider;
  /** The most results one search returns. The model can ask for fewer. */
  limit: number;
}

export const DEFAULT_SETTINGS: ResearchSettings = {
  provider: "ceramic",
  limit: 5
};

export function isResearchSettings(value: unknown): value is ResearchSettings {
  if (typeof value !== "object" || value === null) return false;
  const { provider, limit } = value as Record<string, unknown>;
  return (
    PROVIDERS.some((p) => p === provider) &&
    typeof limit === "number" &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_WEB_SEARCH_LIMIT
  );
}

/** Chat messages with the `web_search` tool's input and output typed. */
export type ResearchMessage = UIMessage<
  unknown,
  UIDataTypes,
  { web_search: { input: WebSearchToolInput; output: WebSearchToolOutput } }
>;
