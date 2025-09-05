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
export const clientTools: Record<string, AITool> = {
  getLocalTime: getLocalTimeTool as AITool,
  getWeatherInformation: {
    description: getWeatherInformationTool.description,
    inputSchema: getWeatherInformationTool.inputSchema
  },
  getLocalNews: {
    description: getLocalNewsTool.description,
    inputSchema: getLocalNewsTool.inputSchema
  }
};
