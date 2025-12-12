import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "agents/react";

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================
// Pure functions that contain the actual tool logic.
// These are referenced by both server and client tool definitions.

/**
 * Gets the current time for a location.
 * In a real app, this would call a timezone API.
 */
async function getLocalTime(input: { location: string }): Promise<string> {
  console.log(`[Tool] Getting local time for ${input.location}`);
  // Simulate API call
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return `The current time in ${input.location} is 10:00 AM`;
}

/**
 * Gets weather information for a city.
 * This is a server-only tool - no client implementation.
 */
export async function getWeatherInformation(input: {
  city: string;
}): Promise<string> {
  console.log(`[Tool] Getting weather for ${input.city}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const conditions = ["sunny", "cloudy", "rainy", "snowy"];
  const condition = conditions[Math.floor(Math.random() * conditions.length)];
  return `The weather in ${input.city} is ${condition}, 72°F`;
}

/**
 * Gets local news for a location.
 * Auto-executes without confirmation (safe read operation).
 */
async function getLocalNews(input: { location: string }): Promise<string> {
  console.log(`[Tool] Getting news for ${input.location}`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return `Breaking: ${input.location} kittens found drinking tea this weekend!`;
}

// =============================================================================
// SCHEMAS
// =============================================================================
// Zod schemas define the input structure for each tool.
// Used by the AI SDK for validation and type inference.

const locationSchema = z.object({
  location: z.string().describe("The location to query")
});

const citySchema = z.object({
  city: z.string().describe("The city name")
});

// =============================================================================
// SERVER TOOLS (AI SDK Format)

export const serverTools = {
  /**
   * Client-executable tool with confirmation.
   * Server only needs the schema - client handles execution after user approves.
   */
  getLocalTime: tool({
    description: "Get the current local time for a location",
    inputSchema: locationSchema
    // No execute - client handles this after user confirmation
  }),

  /**
   * Server-only tool requiring confirmation.
   * No execute function means the server must handle execution
   * after receiving user approval.
   */
  getWeatherInformation: tool({
    description:
      "Get current weather for a city. Use this when users ask about weather.",
    inputSchema: citySchema
    // No execute - server handles after user confirmation (via processToolCalls)
  }),

  /**
   * Client-executable tool without confirmation.
   * Has execute so it auto-runs on client.
   */
  getLocalNews: tool({
    description: "Get local news headlines for a location",
    inputSchema: locationSchema,
    execute: getLocalNews
  })
};

// Legacy alias for backwards compatibility
export const tools = serverTools;

// =============================================================================
// CLIENT TOOLS (useChat Format)
// =============================================================================
// Used with the useChat hook for declarative tool configuration.
// The `confirm` and `execute` properties determine behavior:
//
// | execute | confirm | Behavior                    |
// |---------|---------|----------------------------- |
// | yes     | false   | Auto-runs on client          |
// | yes     | true    | User approves, runs on client |
// | no      | true    | User approves, runs on server |
// | no      | false   | Auto-runs on server          |

export const clientTools: Record<string, Tool> = {
  /**
   * Runs on CLIENT after user confirmation.
   * - Has `execute`: runs in browser
   * - Has `confirm: true`: shows approval UI first
   */
  getLocalTime: {
    description: "Get the current local time for a location",
    execute: getLocalTime,
    confirm: true
  },

  /**
   * Runs on SERVER after user confirmation.
   * - No `execute`: server handles it
   * - No `confirm`: defaults to true for server tools
   */
  getWeatherInformation: {
    description:
      "Get current weather for a city. Use this when users ask about weather."
    // No execute = server-side
    // confirm defaults to true for server tools
  },

  /**
   * Auto-runs on CLIENT (no confirmation).
   * - Has `execute`: runs in browser
   * - No `confirm`: defaults to false for client tools
   */
  getLocalNews: {
    description: "Get local news headlines for a location",
    execute: getLocalNews
    // No confirm = auto-execute for client tools
  }
};

/**
 * Names of tools that require user confirmation.
 * Derived from clientTools config - not hardcoded!
 */
export const toolsRequiringConfirmation = Object.entries(clientTools)
  .filter(([_, tool]) => {
    // Explicit confirm takes precedence
    if (tool.confirm !== undefined) return tool.confirm;
    // Default: server tools (no execute) require confirmation
    return !tool.execute;
  })
  .map(([name]) => name);
