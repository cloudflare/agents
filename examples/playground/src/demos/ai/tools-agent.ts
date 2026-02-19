import { createWorkersAI } from "workers-ai-provider";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

export class ToolsAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant that demonstrates three kinds of tool execution:\n" +
        "1. Server-side tools (getWeather, rollDice) — run automatically on the server.\n" +
        "2. Client-side tools (getUserTimezone, getScreenSize) — executed in the user's browser, no execute function on the server.\n" +
        "3. Approval-required tools (calculate, deleteFile) — need user confirmation before running. Calculate requires approval when either number exceeds 1000.\n\n" +
        "When asked, use the appropriate tools. Explain which type of tool you're using.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // ── Server-side tools (execute automatically) ──
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "rainy", "snowy", "windy"];
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

        rollDice: tool({
          description: "Roll one or more dice with a given number of sides",
          inputSchema: z.object({
            count: z
              .number()
              .int()
              .min(1)
              .max(10)
              .describe("Number of dice to roll"),
            sides: z
              .number()
              .int()
              .min(2)
              .max(100)
              .describe("Number of sides per die")
          }),
          execute: async ({ count, sides }) => {
            const rolls = Array.from(
              { length: count },
              () => Math.floor(Math.random() * sides) + 1
            );
            return {
              rolls,
              total: rolls.reduce((a, b) => a + b, 0),
              description: `${count}d${sides}`
            };
          }
        }),

        // ── Client-side tools (no execute — handled via onToolCall) ──
        getUserTimezone: tool({
          description:
            "Get the user's timezone and local time from their browser",
          inputSchema: z.object({})
        }),

        getScreenSize: tool({
          description: "Get the user's screen dimensions from their browser",
          inputSchema: z.object({})
        }),

        // ── Approval-required tools (need user confirmation) ──
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
        }),

        deleteFile: tool({
          description:
            "Delete a file by path. Always requires approval before proceeding.",
          inputSchema: z.object({
            path: z.string().describe("File path to delete")
          }),
          needsApproval: async () => true,
          execute: async ({ path }) => {
            return {
              path,
              deleted: true,
              message: `File "${path}" has been deleted (simulated)`
            };
          }
        })
      },
      stopWhen: stepCountIs(5)
    });

    return result.toUIMessageStreamResponse();
  }
}
