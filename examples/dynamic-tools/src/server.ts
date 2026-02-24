import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, createToolsFromClientSchemas } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs
} from "ai";

/**
 * Dynamic Tools Agent — demonstrates the SDK/platform pattern.
 *
 * This server does NOT define any tools at deploy time. Instead, it accepts
 * tool schemas from the client via `options.clientTools` and registers them
 * dynamically using `createToolsFromClientSchemas()`.
 *
 * This is the pattern you would use when building an SDK or platform where
 * third-party developers define tools in their embedding application,
 * and the server is shared infrastructure they do not control.
 */
export class DynamicToolsAgent extends AIChatAgent {
  async onChatMessage(
    _onFinish: Parameters<AIChatAgent["onChatMessage"]>[0],
    options: Parameters<AIChatAgent["onChatMessage"]>[1]
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant. You have access to tools provided by " +
        "the embedding application. Use them when asked. If no tools are " +
        "available, let the user know they can enable tools in the sidebar.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      // Dynamic tools from client — the server does not know these at deploy time
      tools: createToolsFromClientSchemas(options?.clientTools),
      stopWhen: stepCountIs(5)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
