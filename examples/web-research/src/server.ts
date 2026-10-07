import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { WebSearchError, webSearchTool } from "agents/websearch/ai-sdk";
import { convertToModelMessages, isStepCount, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  DEFAULT_SETTINGS,
  isResearchSettings,
  MAX_DESCRIPTION_CHARS,
  MODEL,
  type ResearchSettings
} from "./shared";

export class ResearchAgent extends AIChatAgent<Env, ResearchSettings> {
  maxPersistedMessages = 200;
  initialState = DEFAULT_SETTINGS;

  // The client changes the settings with `setState`. Reject anything the
  // tool would refuse, so a bad value never reaches a search.
  validateStateChange(next: ResearchSettings) {
    if (!isResearchSettings(next)) {
      throw new Error("Invalid research settings");
    }
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const { provider, limit } = this.state;

    const tools = {
      // The model picks the query and, optionally, how many results it
      // wants. Everything else is the host's call: the provider and the
      // cap on results (both set from the UI here), the AI Gateway that
      // bills the search, and how much of each result the model reads.
      web_search: webSearchTool({
        binding: this.env.AI,
        provider,
        limit,
        maxDescriptionChars: MAX_DESCRIPTION_CHARS
      })
    };

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai(MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      instructions: researchInstructions(new Date()),
      // Passing `tools` replays earlier searches the way the model first
      // saw them (the trimmed text from `toModelOutput`), not as the full
      // JSON the UI keeps.
      messages: await convertToModelMessages(this.messages, { tools }),
      tools,
      stopWhen: isStepCount(8)
    });

    return result.toUIMessageStreamResponse({ onError: describeError });
  }
}

function researchInstructions(today: Date): string {
  return [
    "You are a research assistant that answers from the live web.",
    `Today is ${today.toISOString().slice(0, 10)}.`,
    "Search before answering anything current, factual, or likely to have changed.",
    "Start with one focused query. If the results are thin, search again with a rephrased query rather than guessing.",
    "Answer concisely from the results. Cite sources inline as numbered markdown links, like [1](https://example.com/page), and reuse a number when you cite the same page again.",
    "If web search is unavailable, say so and answer from what you know, making clear it may be out of date."
  ].join(" ");
}

/**
 * The error text the UI shows. The AI SDK shows "An error occurred." unless
 * told otherwise. A failed search throws a
 * `WebSearchError` whose `message` is written for the model and whose
 * `cause` carries the API's explanation, which is what a developer needs.
 */
function describeError(error: unknown): string {
  if (error instanceof WebSearchError) {
    const detail = error.cause instanceof WebSearchError ? error.cause : error;
    return `${detail.message} (${detail.code})`;
  }
  // Anything else is usually the model call failing, e.g. a Workers AI
  // "8005: Internal server error". Fine to show in a demo; a production app
  // would log it and show something vaguer.
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
