import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type StreamTextOnFinishCallback,
  streamText
} from "ai";
import { tools } from "./tools";
import {
  processToolCalls,
  hasToolConfirmation,
  getWeatherInformation
} from "./utils";

type Env = {
  OPENAI_API_KEY: string;
};

export class HumanInTheLoop extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const startTime = Date.now();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const lastMessage = this.messages[this.messages.length - 1];

        if (hasToolConfirmation(lastMessage)) {
          // Process tool confirmations and return early if any tool was executed
          await processToolCalls(
            { writer, messages: this.messages, tools },
            { getWeatherInformation }
          );
          return;
        }

        const result = streamText({
          messages: convertToModelMessages(this.messages),
          model: openai("gpt-4o"),
          onFinish,
          tools
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    const response = createUIMessageStreamResponse({ stream });

    // Log metadata (simulating what the metadata feature will do)
    const metadata = {
      model: "gpt-4o",
      responseTime: Date.now() - startTime,
      sessionId: `session-${Date.now()}`,
      messageCount: this.messages.length,
      conversationTurns: Math.floor(this.messages.length / 2),
      hasTools: true,
      toolsAvailable: Object.keys(tools).length,
      humanInLoopEnabled: true,
      timestamp: new Date().toISOString()
    };

    console.log(
      "[HumanInTheLoop] Metadata:",
      JSON.stringify(metadata, null, 2)
    );

    // Once the metadata feature is available in the workspace version, use:
    // return this.withMetadata(response, metadata);

    return response;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
