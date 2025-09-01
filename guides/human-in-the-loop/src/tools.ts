import { tool } from "ai";
import { z } from "zod";
import type { AITool } from "agents/ai-react";

const getWeatherInformationTool = tool({
  description:
    "Get the current weather information for a specific city. Always use this tool when the user asks about weather.",
  inputSchema: z.object({
    city: z.string().describe("The name of the city to get weather for")
  })
  // no execute function, we want human in the loop
});

const getLocalTimeTool = tool({
  description: "get the local time for a specified location",
  inputSchema: z.object({ location: z.string() }),
  // including execute function -> no confirmation required
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    return "10am";
  }
});

// Export AI SDK tools for server-side use
export const tools = {
  getLocalTime: getLocalTimeTool,
  getWeatherInformation: getWeatherInformationTool
};

// Export AITool format for client-side use
export const clientTools: Record<string, AITool> = {
  getLocalTime: {
    description: getLocalTimeTool.description,
    inputSchema: getLocalTimeTool.inputSchema,
    execute: async (...args: unknown[]) => {
      const input = args[0] as { location: string };
      console.log(`Getting local time for ${input.location}`);
      return "10am";
    }
  },
  getWeatherInformation: {
    description: getWeatherInformationTool.description,
    inputSchema: getWeatherInformationTool.inputSchema
    // no execute function - requires human confirmation
  }
};
