/**
 * Tests for generateTypes edge cases and sanitizeToolName.
 * Core schema conversion tests (both JSON Schema and Zod paths) live in
 * schema-conversion.test.ts.
 */
import { describe, it, expect } from "vitest";
import { generateTypes, sanitizeToolName } from "../types";
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

describe("generateTypes edge cases", () => {
  it("should handle empty tool set", () => {
    const result = generateTypes({});
    expect(result).toContain("declare const codemode");
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
});
