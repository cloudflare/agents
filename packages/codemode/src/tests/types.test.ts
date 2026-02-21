/**
 * Tests for generateTypes and sanitizeToolName.
 */
import { describe, it, expect } from "vitest";
import { generateTypes, sanitizeToolName } from "../types";
import { z } from "zod";
import { fromJSONSchema } from "zod/v4";
import { tool } from "ai";
import type { ToolDescriptors } from "../types";
import type { ToolSet } from "ai";

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

  it("should handle fromJSONSchema schemas (MCP tools)", () => {
    const jsonSchema = {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" }
      },
      required: ["query"]
    };

    const tools: ToolDescriptors = {
      search: {
        description: "Search documents",
        inputSchema: fromJSONSchema(jsonSchema)
      }
    };

    const result = generateTypes(tools);
    expect(result).toBe(`type SearchInput = {
    /** Search query */
    query: string;
    [x: string]: unknown;
};
type SearchOutput = unknown

declare const codemode: {
\t/**
\t * Search documents
\t * @param input.query - Search query
\t */
\tsearch: (input: SearchInput) => Promise<SearchOutput>;
}`);
  });

  it("should handle AI SDK tool() with Zod schema", () => {
    const tools: ToolSet = {
      getWeather: tool({
        description: "Get weather",
        parameters: z.object({
          city: z.string()
        }),
        execute: async () => ({ temp: 20 })
      })
    };

    const result = generateTypes(tools);
    expect(result).toBe(`type GetWeatherInput = {
    city: string;
};
type GetWeatherOutput = unknown

declare const codemode: {
\t/**
\t * Get weather
\t */
\tgetWeather: (input: GetWeatherInput) => Promise<GetWeatherOutput>;
}`);
  });

  it("should handle mixed tools: Zod schemas and fromJSONSchema", () => {
    const jsonSchema = {
      type: "object" as const,
      properties: {
        url: { type: "string" as const }
      },
      required: ["url"]
    };

    const tools: ToolDescriptors = {
      zodTool: {
        description: "Zod tool",
        inputSchema: z.object({ name: z.string() })
      },
      mcpTool: {
        description: "MCP tool",
        inputSchema: fromJSONSchema(jsonSchema)
      }
    };

    const result = generateTypes(tools);
    expect(result).toBe(`type ZodToolInput = {
    name: string;
};
type ZodToolOutput = unknown
type McpToolInput = {
    url: string;
    [x: string]: unknown;
};
type McpToolOutput = unknown

declare const codemode: {
\t/**
\t * Zod tool
\t */
\tzodTool: (input: ZodToolInput) => Promise<ZodToolOutput>;

\t/**
\t * MCP tool
\t */
\tmcpTool: (input: McpToolInput) => Promise<McpToolOutput>;
}`);
  });
});
