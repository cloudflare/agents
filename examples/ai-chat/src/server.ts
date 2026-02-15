import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

/**
 * AI Chat Agent showcasing @cloudflare/ai-chat features:
 * - streamText with toUIMessageStreamResponse (simplest pattern)
 * - Server-side tools with execute
 * - Client-side tools (no execute, handled via onToolCall)
 * - Tool approval with needsApproval
 * - Message pruning for long conversations
 * - Storage management with maxPersistedMessages
 */
export class ChatAgent extends AIChatAgent {
  // Keep the last 200 messages in SQLite storage
  maxPersistedMessages = 200;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant. You can check the weather, get the user's timezone, " +
        "and run calculations. For calculations over $100, you need user approval first.",
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // Server-side tool: executes automatically
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            // In a real app, call a weather API
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

        // Client-side tool: no execute, handled by onToolCall in the client
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
          // No execute -- the client provides the result via onToolCall
        }),

        // Tool with approval: requires user confirmation before executing
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
          // Only require approval when a dollar amount over 100 is involved
          needsApproval: async ({ amount }) => (amount ?? 0) > 100,
          execute: async ({ expression }) => {
            try {
              // Simple eval for demo (use a proper math parser in production)
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
