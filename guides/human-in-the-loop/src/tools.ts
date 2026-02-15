import { tool } from "ai";
import { z } from "zod";

/**
 * Server-side tools for the Human-in-the-Loop guide.
 *
 * All tool schemas and execute functions are defined server-side.
 * For tools that need human approval, use `needsApproval`.
 * For tools that need client-side execution (browser APIs), omit
 * `execute` and handle via `onToolCall` in `useAgentChat`.
 */

/**
 * Weather tool — requires human approval before executing.
 * Uses `needsApproval: true` so the AI SDK pauses and waits for
 * the user to approve/reject before calling execute.
 */
export const getWeatherInformation = tool({
  description:
    "Get the current weather information for a specific city. Always use this tool when the user asks about weather.",
  inputSchema: z.object({
    city: z.string().describe("The name of the city to get weather for")
  }),
  needsApproval: true,
  execute: async ({ city }) => {
    const conditions = ["sunny", "cloudy", "rainy", "snowy"];
    return `The weather in ${city} is ${
      conditions[Math.floor(Math.random() * conditions.length)]
    }.`;
  }
});

/**
 * Local time tool — needs client-side execution (browser timezone).
 * No `execute` function here — the client handles it via `onToolCall`.
 * Also requires approval since it accesses user's location context.
 */
export const getLocalTime = tool({
  description: "Get the local time for a specified location",
  inputSchema: z.object({
    location: z.string().describe("The location to get time for")
  })
  // No execute — handled by onToolCall in the client
});

/**
 * News tool — fully automatic, no approval needed.
 * Executes on the server without user intervention.
 */
export const getLocalNews = tool({
  description: "Get local news for a specified location",
  inputSchema: z.object({
    location: z.string().describe("The location to get news for")
  }),
  execute: async ({ location }) => {
    console.log(`Getting local news for ${location}`);
    await new Promise((res) => setTimeout(res, 1000));
    return `${location} kittens found drinking tea this last weekend`;
  }
});

export const tools = {
  getWeatherInformation,
  getLocalTime,
  getLocalNews
};
