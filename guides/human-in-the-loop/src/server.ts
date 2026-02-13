import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { tools } from "./tools";

export class HumanInTheLoop extends AIChatAgent {
  async onChatMessage() {
    const startTime = Date.now();

    // streamText handles the full tool lifecycle automatically:
    // - Tools with needsApproval pause for user approval via the AI SDK
    // - Tools without execute wait for client-side onToolCall results
    // - Tools with execute run server-side automatically
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      messages: await convertToModelMessages(this.messages),
      // @ts-expect-error — model not yet in workers-ai-provider types
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      tools,
      stopWhen: stepCountIs(5)
    });

    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        if (part.type === "start") {
          return {
            model: "gpt-4o",
            createdAt: Date.now(),
            messageCount: this.messages.length
          };
        }
        if (part.type === "finish") {
          return {
            responseTime: Date.now() - startTime,
            totalTokens: part.totalUsage?.totalTokens
          };
        }
      }
    });
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
