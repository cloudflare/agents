import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "agents/react";

// =============================================================================
// AI SDK TOOLS (for server-side use in AIChatAgent)
// =============================================================================

// Server-side tool that requires confirmation (no execute function)
const getWeatherInformationTool = tool({
  description:
    "Get the current weather information for a specific city. Always use this tool when the user asks about weather.",
  inputSchema: z.object({
    city: z.string().describe("The name of the city to get weather for")
  })
  // No execute = server-side, requires human-in-the-loop confirmation
});

// Client-side tool (has execute function)
const getLocalTimeTool = tool({
  description: "Get the local time for a specified location",
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    await new Promise((res) => setTimeout(res, 2000));
    return "10am";
  }
});

// Server-side tool with execute (does NOT require confirmation)
const getLocalNewsTool = tool({
  description: "Get local news for a specified location",
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local news for ${location}`);
    await new Promise((res) => setTimeout(res, 2000));
    return `${location} kittens found drinking tea this last weekend`;
  }
});

// Export AI SDK tools for server-side use (in AIChatAgent.onChatMessage)
export const tools = {
  getLocalTime: {
    description: getLocalTimeTool.description,
    inputSchema: getLocalTimeTool.inputSchema
  },
  getWeatherInformation: getWeatherInformationTool,
  getLocalNews: getLocalNewsTool
};

// =============================================================================
// CLIENT-SIDE TOOLS (for useChat hook)
// Uses the new declarative Tool type with cleaner DX
// =============================================================================

/**
 * Client tools using the new declarative API:
 *
 * - Tools WITH `execute`: Run on client
 * - Tools WITHOUT `execute`: Run on server
 * - `confirm: true` requires user approval before execution
 * - `confirm: false` (or omitted for client tools) = auto-executes
 *
 * This replaces the old pattern of:
 * - tools + toolsRequiringConfirmation + experimental_automaticToolResolution
 */
export const clientTools: Record<string, Tool> = {
  // Client-side tool that requires user confirmation
  getLocalTime: {
    description: "Get the local time for a specified location",
    execute: async (input: { location: string }) => {
      console.log(`Getting local time for ${input.location}`);
      await new Promise((res) => setTimeout(res, 2000));
      return "10am";
    },
    confirm: true // Requires user approval despite having execute
  },

  // Server-side tool that requires confirmation (default for server tools)
  getWeatherInformation: {
    description:
      "Get the current weather information for a specific city. Always use this tool when the user asks about weather."
    // No execute = server-side
    // No confirm = defaults to true for server-side tools (requires confirmation)
  },

  // Client-side tool that auto-executes (no confirmation needed)
  getLocalNews: {
    description: "Get local news for a specified location",
    execute: async (input: { location: string }) => {
      console.log(`Getting local news for ${input.location}`);
      await new Promise((res) => setTimeout(res, 2000));
      return `${input.location} kittens found drinking tea this last weekend`;
    }
    // No confirm = defaults to false for client-side tools (auto-executes)
  }
};
