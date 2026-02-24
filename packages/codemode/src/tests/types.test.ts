/**
 * Tests for generateTypes and sanitizeToolName.
 */
import { describe, it, expect } from "vitest";
import { generateTypes, sanitizeToolName } from "../types";
import { z } from "zod";
import { fromJSONSchema } from "zod/v4";
import { jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { ToolDescriptors } from "../types";

// Helper: cast loosely-typed tool objects for generateTypes
function genTypes(tools: Record<string, unknown>): string {
  return generateTypes(tools as unknown as ToolSet);
}

describe("sanitizeToolName", () => {
  it("should replace hyphens with underscores", () => {
    expect(sanitizeToolName("get-weather")).toBe("get_weather");
  });

  it("should replace dots with underscores", () => {
    expect(sanitizeToolName("api.v2.search")).toBe("api_v2_search");
  });

  it("should replace spaces with underscores", () => {
    expect(sanitizeToolName("my tool")).toBe("my_tool");
  });

  it("should prefix digit-leading names with underscore", () => {
    expect(sanitizeToolName("3drender")).toBe("_3drender");
  });

  it("should append underscore to reserved words", () => {
    expect(sanitizeToolName("class")).toBe("class_");
    expect(sanitizeToolName("return")).toBe("return_");
    expect(sanitizeToolName("delete")).toBe("delete_");
  });

  it("should strip special characters", () => {
    expect(sanitizeToolName("hello@world!")).toBe("helloworld");
  });

  it("should handle empty string", () => {
    expect(sanitizeToolName("")).toBe("_");
  });

  it("should handle string with only special characters", () => {
    // $ is a valid identifier character, so "@#$" → "$"
    expect(sanitizeToolName("@#$")).toBe("$");
    expect(sanitizeToolName("@#!")).toBe("_");
  });

  it("should leave valid identifiers unchanged", () => {
    expect(sanitizeToolName("getWeather")).toBe("getWeather");
    expect(sanitizeToolName("_private")).toBe("_private");
    expect(sanitizeToolName("$jquery")).toBe("$jquery");
  });
});

describe("generateTypes", () => {
  it("should generate types for simple tools", () => {
    const tools: ToolDescriptors = {
      getWeather: {
        description: "Get weather for a location",
        inputSchema: z.object({ location: z.string() })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("GetWeatherInput");
    expect(result).toContain("GetWeatherOutput");
    expect(result).toContain("declare const codemode");
    expect(result).toContain("getWeather");
    expect(result).toContain("Get weather for a location");
  });

  it("should generate types for nested schemas", () => {
    const tools: ToolDescriptors = {
      createUser: {
        description: "Create a user",
        inputSchema: z.object({
          name: z.string(),
          address: z.object({
            street: z.string(),
            city: z.string()
          })
        })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("CreateUserInput");
    expect(result).toContain("name");
    expect(result).toContain("address");
  });

  it("should handle optional fields", () => {
    const tools: ToolDescriptors = {
      search: {
        description: "Search",
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().optional()
        })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("SearchInput");
    expect(result).toContain("query");
    expect(result).toContain("limit");
  });

  it("should handle enums", () => {
    const tools: ToolDescriptors = {
      sort: {
        description: "Sort items",
        inputSchema: z.object({
          order: z.enum(["asc", "desc"])
        })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("SortInput");
  });

  it("should handle arrays", () => {
    const tools: ToolDescriptors = {
      batch: {
        description: "Batch process",
        inputSchema: z.object({
          items: z.array(z.string())
        })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("BatchInput");
    expect(result).toContain("items");
  });

  it("should handle empty tool set", () => {
    const result = generateTypes({});
    expect(result).toContain("declare const codemode");
  });

  it("should include JSDoc param descriptions from z.describe()", () => {
    const tools: ToolDescriptors = {
      search: {
        description: "Search the web",
        inputSchema: z.object({
          query: z.string().describe("The search query"),
          limit: z.number().describe("Max results to return")
        })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("@param input.query - The search query");
    expect(result).toContain("@param input.limit - Max results to return");
  });

  it("should sanitize tool names with hyphens", () => {
    const tools: ToolDescriptors = {
      "get-weather": {
        description: "Get weather",
        inputSchema: z.object({ location: z.string() })
      }
    };

    const result = generateTypes(tools);
    // Tool name in codemode declaration is sanitized
    expect(result).toContain("get_weather");
    // toCamelCase("get_weather") → "GetWeather"
    expect(result).toContain("GetWeatherInput");
  });

  it("should handle MCP tools with input and output schemas (fromJSONSchema)", () => {
    // MCP tools use JSON Schema format for both input and output
    const inputSchema = {
      type: "object" as const,
      properties: {
        city: { type: "string" as const, description: "City name" },
        units: {
          type: "string" as const,
          enum: ["celsius", "fahrenheit"],
          description: "Temperature units"
        },
        includeForecast: { type: "boolean" as const }
      },
      required: ["city"]
    };

    const outputSchema = {
      type: "object" as const,
      properties: {
        temperature: { type: "number" as const, description: "Current temp" },
        humidity: { type: "number" as const },
        conditions: { type: "string" as const },
        forecast: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              day: { type: "string" as const },
              high: { type: "number" as const },
              low: { type: "number" as const }
            }
          }
        }
      },
      required: ["temperature", "conditions"]
    };

    const tools: ToolDescriptors = {
      getWeather: {
        description: "Get weather for a city",
        inputSchema: fromJSONSchema(inputSchema),
        outputSchema: fromJSONSchema(outputSchema)
      }
    };

    const result = generateTypes(tools);

    // Input schema types
    expect(result).toContain("type GetWeatherInput");
    expect(result).toContain("city: string");
    expect(result).toContain("units?:");
    expect(result).toContain("includeForecast?: boolean");

    // Output schema types (not unknown)
    expect(result).toContain("type GetWeatherOutput");
    expect(result).not.toContain("GetWeatherOutput = unknown");
    expect(result).toContain("temperature: number");
    expect(result).toContain("humidity?: number");
    expect(result).toContain("conditions: string");
    expect(result).toContain("forecast?:");
    expect(result).toContain("day?: string");
    expect(result).toContain("high?: number");
    expect(result).toContain("low?: number");

    // JSDoc
    expect(result).toContain("@param input.city - City name");
    expect(result).toContain("/** Current temp */");
  });

  it("should handle Zod schemas with input and output schemas", () => {
    // Direct ToolDescriptors with Zod schemas (what generateTypes operates on)
    const tools: ToolDescriptors = {
      getWeather: {
        description: "Get weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name"),
          units: z.enum(["celsius", "fahrenheit"]).optional()
        }),
        outputSchema: z.object({
          temperature: z.number().describe("Current temperature"),
          humidity: z.number().describe("Humidity percentage"),
          conditions: z.string().describe("Weather conditions"),
          forecast: z.array(
            z.object({
              day: z.string(),
              high: z.number(),
              low: z.number()
            })
          )
        })
      }
    };

    const result = generateTypes(tools);

    // Verify input schema
    expect(result).toContain("type GetWeatherInput");
    expect(result).toContain("city: string");
    expect(result).toContain("units?:");
    expect(result).toContain('"celsius"');
    expect(result).toContain('"fahrenheit"');

    // Verify output schema is properly typed (not unknown)
    expect(result).toContain("type GetWeatherOutput");
    expect(result).not.toContain("GetWeatherOutput = unknown");
    expect(result).toContain("temperature: number");
    expect(result).toContain("humidity: number");
    expect(result).toContain("conditions: string");
    expect(result).toContain("forecast:");
    expect(result).toContain("day: string");
    expect(result).toContain("high: number");
    expect(result).toContain("low: number");

    // Verify JSDoc comments from .describe()
    expect(result).toContain("/** City name */");
    expect(result).toContain("/** Current temperature */");
    expect(result).toContain("@param input.city - City name");
  });

  it("should handle null inputSchema gracefully", () => {
    const tools = {
      broken: {
        description: "Broken tool",
        inputSchema: null
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type BrokenInput = unknown");
    expect(result).toContain("type BrokenOutput = unknown");
    expect(result).toContain("broken:");
  });

  it("should handle undefined inputSchema gracefully", () => {
    const tools = {
      broken: {
        description: "Broken tool",
        inputSchema: undefined
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type BrokenInput = unknown");
    expect(result).toContain("type BrokenOutput = unknown");
    expect(result).toContain("broken:");
  });

  it("should handle string inputSchema gracefully", () => {
    const tools = {
      broken: {
        description: "Broken tool",
        inputSchema: "not a schema"
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type BrokenInput = unknown");
    expect(result).toContain("broken:");
  });

  it("should isolate errors: one throwing tool does not break others", () => {
    // Create a tool with a getter that throws
    const throwingSchema = {
      get jsonSchema(): never {
        throw new Error("Schema explosion");
      }
    };

    const tools = {
      good1: {
        description: "Good first",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { a: { type: "string" as const } }
        })
      },
      bad: {
        description: "Bad tool",
        inputSchema: throwingSchema
      },
      good2: {
        description: "Good second",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { b: { type: "number" as const } }
        })
      }
    };

    const result = genTypes(tools);

    // Good tools should work fine
    expect(result).toContain("type Good1Input");
    expect(result).toContain("a?: string;");
    expect(result).toContain("type Good2Input");
    expect(result).toContain("b?: number;");

    // Bad tool should degrade to unknown
    expect(result).toContain("type BadInput = unknown");
    expect(result).toContain("type BadOutput = unknown");

    // All three tools should appear in the codemode declaration
    expect(result).toContain("good1:");
    expect(result).toContain("bad:");
    expect(result).toContain("good2:");
  });

  it("should handle AI SDK jsonSchema wrapper (MCP tools)", () => {
    // This is what MCP tools look like when using the AI SDK jsonSchema wrapper
    const inputJsonSchema = {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" },
        limit: { type: "number" as const, description: "Max results" }
      },
      required: ["query"]
    };

    const outputJsonSchema = {
      type: "object" as const,
      properties: {
        results: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              title: { type: "string" as const },
              url: { type: "string" as const }
            }
          }
        },
        total: { type: "number" as const }
      }
    };

    // Use AI SDK jsonSchema wrapper (what MCP client returns)
    const tools = {
      search: {
        description: "Search the web",
        inputSchema: jsonSchema(inputJsonSchema),
        outputSchema: jsonSchema(outputJsonSchema)
      }
    };

    const result = generateTypes(tools as unknown as ToolDescriptors);

    // Input schema types
    expect(result).toContain("type SearchInput");
    expect(result).toContain("query: string");
    expect(result).toContain("limit?: number");

    // Output schema types (not unknown)
    expect(result).toContain("type SearchOutput");
    expect(result).not.toContain("SearchOutput = unknown");
    expect(result).toContain("results?:");
    expect(result).toContain("title?: string");
    expect(result).toContain("url?: string");
    expect(result).toContain("total?: number");

    // JSDoc from JSON Schema descriptions
    expect(result).toContain("@param input.query - Search query");
    expect(result).toContain("@param input.limit - Max results");
  });
});
