import { tool } from "ai";
import { z } from "zod";
import type { AITool } from "agents/ai-react";

// Server-side tool that requires confirmation
const getWeatherInformationTool = tool({
  description:
    "Get the current weather information for a specific city. Always use this tool when the user asks about weather.",
  inputSchema: z.object({
    city: z.string().describe("The name of the city to get weather for")
  })
  // no execute function, we want human in the loop
});

// Client-side tool that requires confirmation
const getLocalTimeTool = tool({
  description: "get the local time for a specified location",
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    await new Promise((res) => setTimeout(res, 2000));
    return "10am";
  }
});

// Server-side tool that does NOT require confirmation
const getLocalNewsTool = tool({
  description: "get local news for a specified location",
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local news for ${location}`);
    await new Promise((res) => setTimeout(res, 2000));
    return `${location} kittens found drinking tea this last weekend`;
  }
});

// Export AI SDK tools for server-side use
export const tools = {
  getLocalTime: {
    description: getLocalTimeTool.description,
    inputSchema: getLocalTimeTool.inputSchema
  },
  getWeatherInformation: getWeatherInformationTool,
  getLocalNews: getLocalNewsTool
};

// Export AITool format for client-side use
// AITool uses JSON Schema (not Zod) because it needs to be serialized over the wire.
// Only tools with `execute` need `parameters` - they get extracted and sent to the server.
// Tools without `execute` are server-side only and just need description for display.
export const clientTools: Record<string, AITool> = {
  getLocalTime: {
    description: "get the local time for a specified location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" }
      },
      required: ["location"]
    },
    execute: async (input) => {
      const { location } = input as { location: string };
      console.log(`Getting local time for ${location}`);
      await new Promise((res) => setTimeout(res, 2000));
      return "10am";
    }
  },
  // Server-side tools: no execute, no parameters needed (schema lives on server)
  getWeatherInformation: {
    description:
      "Get the current weather information for a specific city. Always use this tool when the user asks about weather."
  },
  getLocalNews: {
    description: "get local news for a specified location"
  }
};
