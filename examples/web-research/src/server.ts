import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { WebSearchError, webSearchTool } from "agents/websearch/ai-sdk";
import { convertToModelMessages, isStepCount, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { MAX_DESCRIPTION_CHARS } from "./shared";

export class ResearchAgent extends AIChatAgent {
  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const tools = {
      // The model picks the query and, optionally, how many results it
      // wants. Everything else is fixed here: the provider ("ceramic",
      // "exa", or "linkup"), the AI Gateway that bills the search, the cap
      // on results, and how much of each result the model reads.
      web_search: webSearchTool({
        binding: this.env.AI,
        provider: "ceramic",
        limit: 5,
        maxDescriptionChars: MAX_DESCRIPTION_CHARS
      })
    };

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.7-code", {
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
 * The text a failed tool call shows in the UI. The AI SDK shows "An error
 * occurred." unless told otherwise. A failed search throws a
 * `WebSearchError` whose `message` is written for the model and whose
 * `cause` carries the API's explanation, which is what a developer needs.
 */
function describeError(error: unknown): string {
  if (!(error instanceof WebSearchError)) return "Something went wrong.";
  const detail = error.cause instanceof WebSearchError ? error.cause : error;
  return `${detail.message} (${detail.code})`;
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
