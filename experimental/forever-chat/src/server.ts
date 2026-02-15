/**
 * Forever Chat — Durable AI streaming that survives DO eviction.
 *
 * Uses the withDurableChat mixin to add keepAlive during streaming.
 * The DO stays alive while the LLM generates, preventing idle eviction.
 *
 * This is the same as the ai-chat example, but extends
 * withDurableChat(AIChatAgent) instead of AIChatAgent directly.
 */
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { withDurableChat } from "@cloudflare/ai-chat/experimental/forever";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

// Apply the durable chat mixin
const DurableChatAgent = withDurableChat(AIChatAgent);

export class ForeverChatAgent extends DurableChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant running as a durable agent. " +
        "Your streaming connection is kept alive via keepAlive(), " +
        "so even long responses won't be interrupted by idle timeouts. " +
        "You can check the weather and perform calculations.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        calculate: tool({
          description:
            "Perform a calculation. Requires approval for large amounts.",
          inputSchema: z.object({
            expression: z.string().describe("Math expression to evaluate"),
            amount: z
              .number()
              .optional()
              .describe("Dollar amount involved, if any")
          }),
          needsApproval: async ({ amount }) => (amount ?? 0) > 100,
          execute: async ({ expression }) => {
            try {
              const result = new Function(`return ${expression}`)();
              return { expression, result: Number(result) };
            } catch {
              return { expression, error: "Invalid expression" };
            }
          }
        })
      },
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
