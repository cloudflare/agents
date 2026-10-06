import { DurableObject } from "cloudflare:workers";
import { tool } from "ai";
import { z } from "zod";
import { routeAgentRequest } from "agents";
import { ThinkChat, ThinkHarness } from "agents/harness/think";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/ai-sdk";
import { WebSockets } from "agents/websockets";

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/**
 * Think's agent loop on a plain Durable Object: ThinkHarness keeps the
 * transcript, runs turns and brings them back after an eviction, and
 * ThinkChat speaks the protocol `useAgentChat` expects.
 */
export class ThinkAgent extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });
  readonly harness = new ThinkHarness({
    model: this.ai(MODEL_ID),
    system:
      "You are a concise assistant. Use getWeather for weather questions, getUserTimezone when you need the user's time zone, and sendNotification when asked to notify someone.",
    tools: {
      // A read with no side effects: if an eviction cuts a call short, the
      // harness runs it again.
      getWeather: {
        ...tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "raining", "snowing"];
            const condition =
              conditions[Math.floor(Math.random() * conditions.length)];
            return {
              city,
              condition,
              temperatureC: 5 + Math.round(Math.random() * 25)
            };
          }
        }),
        recovery: "rerun"
      },
      // A side effect: it waits for the user's approval, and an interrupted
      // call is reported to the model rather than repeated.
      sendNotification: tool({
        description: "Send a notification to someone",
        inputSchema: z.object({ to: z.string(), message: z.string() }),
        needsApproval: true,
        execute: async ({ to }) => ({ delivered: true, to })
      }),
      // No execute: the browser runs it and sends the result back.
      getUserTimezone: tool({
        description: "Get the user's time zone from their browser",
        inputSchema: z.object({})
      })
    }
  });
  readonly webSockets = new WebSockets();
  readonly chat = new ThinkChat({
    harness: this.harness,
    webSockets: this.webSockets
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.webSockets)
    .use(this.chat);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
