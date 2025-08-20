import { tool } from "ai";
import { z } from "zod";

const getWeatherInformation = tool({
  description:
    "Get the current weather information for a specific city. Always use this tool when the user asks about weather.",
  inputSchema: z.object({
    city: z.string().describe("The name of the city to get weather for")
  })
  // no execute function, we want human in the loop
});

const getLocalTime = tool({
  description: "get the local time for a specified location",
  inputSchema: z.object({ location: z.string() }),
  // including execute function -> no confirmation required
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    return "10am";
  }
});

export const tools = {
  getLocalTime,
  getWeatherInformation
};
