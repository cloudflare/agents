/**
 * Tests for codemode schema conversion.
 * Focus on our own code, not testing zod-to-ts library.
 */
import { z } from "zod";
import { jsonSchema } from "ai";
import { describe, it, expect } from "vitest";
import { generateTypes, sanitizeToolName } from "../types";

describe("sanitizeToolName", () => {
  it("replaces hyphens with underscores", () => {
    expect(sanitizeToolName("get-user")).toBe("get_user");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeToolName("api.v2.search")).toBe("api_v2_search");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeToolName("my tool")).toBe("my_tool");
  });

  it("prefixes digit-leading names", () => {
    expect(sanitizeToolName("3drender")).toBe("_3drender");
  });

  it("appends underscore to reserved words", () => {
    expect(sanitizeToolName("class")).toBe("class_");
    expect(sanitizeToolName("return")).toBe("return_");
    expect(sanitizeToolName("function")).toBe("function_");
  });

  it("strips invalid characters", () => {
    expect(sanitizeToolName("hello@world!")).toBe("helloworld");
  });

  it("handles empty string", () => {
    expect(sanitizeToolName("")).toBe("_");
  });

  it("preserves valid identifiers", () => {
    expect(sanitizeToolName("getUser")).toBe("getUser");
    expect(sanitizeToolName("_private")).toBe("_private");
    expect(sanitizeToolName("$jquery")).toBe("$jquery");
  });

  it("handles MCP-style tool names", () => {
    expect(sanitizeToolName("mcp__server__tool")).toBe("mcp__server__tool");
    expect(sanitizeToolName("tool-with-hyphens")).toBe("tool_with_hyphens");
  });
});

describe("generateTypes with jsonSchema wrapper", () => {
  it("handles simple object schema", () => {
    const tools = {
      getUser: {
        description: "Get a user",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            id: { type: "string" as const }
          },
          required: ["id"]
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("type GetUserInput");
    expect(result).toContain("id: string;");
    expect(result).toContain("type GetUserOutput = unknown");
  });

  it("handles nested objects", () => {
    const tools = {
      createOrder: {
        description: "Create an order",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            user: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                email: { type: "string" as const }
              }
            }
          }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("user?:");
    expect(result).toContain("name?: string;");
    expect(result).toContain("email?: string;");
  });

  it("handles arrays", () => {
    const tools = {
      search: {
        description: "Search",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            tags: {
              type: "array" as const,
              items: { type: "string" as const }
            }
          }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("tags?: string[];");
  });

  it("handles enums", () => {
    const tools = {
      sort: {
        description: "Sort items",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            order: {
              type: "string" as const,
              enum: ["asc", "desc"]
            }
          }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain('"asc" | "desc"');
  });

  it("handles required vs optional fields", () => {
    const tools = {
      query: {
        description: "Query data",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
            limit: { type: "number" as const }
          },
          required: ["query"]
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("query: string;");
    expect(result).toContain("limit?: number;");
  });

  it("handles descriptions in JSDoc", () => {
    const tools = {
      search: {
        description: "Search the web",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            query: { type: "string" as const, description: "Search query" },
            limit: { type: "number" as const, description: "Max results" }
          }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("/** Search query */");
    expect(result).toContain("/** Max results */");
    expect(result).toContain("@param input.query - Search query");
    expect(result).toContain("@param input.limit - Max results");
  });

  it("handles anyOf (union types)", () => {
    const tools = {
      getValue: {
        description: "Get value",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            value: {
              anyOf: [
                { type: "string" as const },
                { type: "number" as const }
              ]
            }
          }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("string | number");
  });

  it("handles output schema", () => {
    const tools = {
      getWeather: {
        description: "Get weather",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            city: { type: "string" as const }
          }
        }),
        outputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            temperature: { type: "number" as const },
            conditions: { type: "string" as const }
          }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("type GetWeatherOutput");
    expect(result).not.toContain("GetWeatherOutput = unknown");
    expect(result).toContain("temperature?: number;");
    expect(result).toContain("conditions?: string;");
  });
});

describe("generateTypes with Zod schema", () => {
  it("handles basic Zod object", () => {
    const tools = {
      getUser: {
        description: "Get a user",
        inputSchema: z.object({
          id: z.string()
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("type GetUserInput");
    expect(result).toContain("id: string");
  });

  it("handles Zod descriptions", () => {
    const tools = {
      search: {
        description: "Search",
        inputSchema: z.object({
          query: z.string().describe("The search query")
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("/** The search query */");
    expect(result).toContain("@param input.query - The search query");
  });
});

describe("generateTypes codemode declaration", () => {
  it("generates proper codemode declaration", () => {
    const tools = {
      tool1: {
        description: "First tool",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { a: { type: "string" as const } }
        })
      },
      tool2: {
        description: "Second tool",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { b: { type: "number" as const } }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("declare const codemode: {");
    expect(result).toContain("tool1: (input: Tool1Input) => Promise<Tool1Output>;");
    expect(result).toContain("tool2: (input: Tool2Input) => Promise<Tool2Output>;");
  });

  it("sanitizes tool names in declaration", () => {
    const tools = {
      "get-user": {
        description: "Get user",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { id: { type: "string" as const } }
        })
      }
    };

    const result = generateTypes(tools as any);

    expect(result).toContain("get_user: (input: GetUserInput)");
  });
});
