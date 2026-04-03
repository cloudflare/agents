/**
 * Forever Chat — Durable AI streaming that survives DO eviction.
 *
 * Uses the withDurableChat mixin to add:
 * - keepAlive during streaming (prevents idle eviction)
 * - Automatic recovery after eviction (persists partial + continues)
 *
 * Zero-config recovery: if the DO is evicted mid-stream, the mixin
 * detects the interrupted stream on restart, persists the partial
 * response, and schedules a continuation that appends to the same
 * assistant message. Connected clients see a seamless resume.
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

const DurableChatAgent = withDurableChat(AIChatAgent);

export class ForeverChatAgent extends DurableChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system:
        "You are a helpful assistant running as a durable agent. " +
        "If your last response appears to be cut off or incomplete, " +
        "seamlessly continue from exactly where it ended — " +
        "do not repeat any text, just pick up mid-sentence or mid-paragraph. " +
        "You can check the weather and perform calculations. " +
        "For calculations with large numbers (over 1000), you need user approval first.",
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
            "Perform a math calculation with two numbers. Requires approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
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
