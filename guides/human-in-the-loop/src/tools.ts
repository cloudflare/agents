import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "agents/react";

// Tool implementations

async function getLocalTime(input: { location: string }): Promise<string> {
  console.log(`[Tool] Getting local time for ${input.location}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return `The current time in ${input.location} is 10:00 AM`;
}

export async function getWeatherInformation(input: {
  city: string;
}): Promise<string> {
  console.log(`[Tool] Getting weather for ${input.city}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const conditions = ["sunny", "cloudy", "rainy", "snowy"];
  const condition = conditions[Math.floor(Math.random() * conditions.length)];
  return `The weather in ${input.city} is ${condition}, 72°F`;
}

async function getLocalNews(input: { location: string }): Promise<string> {
  console.log(`[Tool] Getting news for ${input.location}`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return `Breaking: ${input.location} kittens found drinking tea this weekend!`;
}

// Schemas

const locationSchema = z.object({
  location: z.string().describe("The location to query")
});

const citySchema = z.object({
  city: z.string().describe("The city name")
});

// Server tools (AI SDK format for AIChatAgent)

export const serverTools = {
  getLocalTime: tool({
    description: "Get the current local time for a location",
    inputSchema: locationSchema
  }),

  getWeatherInformation: tool({
    description:
      "Get current weather for a city. Use this when users ask about weather.",
    inputSchema: citySchema
  }),

  getLocalNews: tool({
    description: "Get local news headlines for a location",
    inputSchema: locationSchema,
    execute: getLocalNews
  })
};

export const tools = serverTools;

// Client tools (useChat format)
// execute + confirm determines behavior:
// - execute yes, confirm false: auto-runs on client
// - execute yes, confirm true: user approves, runs on client
// - execute no, confirm true: user approves, runs on server
// - execute no, confirm false: auto-runs on server

export const clientTools: Record<string, Tool> = {
  getLocalTime: {
    description: "Get the current local time for a location",
    execute: getLocalTime,
    confirm: true
  },

  getWeatherInformation: {
    description:
      "Get current weather for a city. Use this when users ask about weather."
  },

  getLocalNews: {
    description: "Get local news headlines for a location",
    execute: getLocalNews
  }
};
