/**
 * Tests for generateTypes edge cases (AI SDK dependent).
 * Core schema conversion tests (both JSON Schema and Zod paths) live in
 * schema-conversion.test.ts.
 * sanitizeToolName tests live in utils.test.ts.
 *
 * Each test uses toBe with the exact expected output so these tests
 * double as documentation for the output format.
 */
import { describe, it, expect } from "vitest";
import { generateTypes } from "../tool-types";
import { fromJSONSchema } from "zod";
import { jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { ToolDescriptors } from "../tool-types";

// Helper: cast loosely-typed tool objects for generateTypes
function genTypes(tools: Record<string, unknown>): string {
  return generateTypes(tools as unknown as ToolSet);
}

describe("generateTypes edge cases", () => {
  it("should handle empty tool set", () => {
    expect(generateTypes({})).toBe("declare const codemode: {}");
  });

  it("should handle MCP tools with input and output schemas (fromJSONSchema)", () => {
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
        temperature: {
          type: "number" as const,
          description: "Current temp"
        },
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

    expect(result).toBe(
      [
        "type GetWeatherInput = {",
        "    /** City name */",
        "    city: string;",
        '    units?: "celsius" | "fahrenheit";',
        "    includeForecast?: boolean;",
        "}",
        "type GetWeatherOutput = {",
        "    /** Current temp */",
        "    temperature: number;",
        "    humidity?: number;",
        "    conditions: string;",
        "    forecast?: {",
        "        day?: string;",
        "        high?: number;",
        "        low?: number;",
        "    }[];",
        "}",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Get weather for a city",
        "\t * @param input.city - City name",
        "\t */",
        "\tgetWeather: (input: GetWeatherInput) => Promise<GetWeatherOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("should handle null inputSchema gracefully", () => {
    const result = genTypes({
      broken: { description: "Broken tool", inputSchema: null }
    });

    expect(result).toBe(
      [
        "type BrokenInput = unknown",
        "type BrokenOutput = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Broken tool",
        "\t */",
        "\tbroken: (input: BrokenInput) => Promise<BrokenOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("should handle undefined inputSchema gracefully", () => {
    const result = genTypes({
      broken: { description: "Broken tool", inputSchema: undefined }
    });

    expect(result).toBe(
      [
        "type BrokenInput = unknown",
        "type BrokenOutput = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Broken tool",
        "\t */",
        "\tbroken: (input: BrokenInput) => Promise<BrokenOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("should handle string inputSchema gracefully", () => {
    const result = genTypes({
      broken: { description: "Broken tool", inputSchema: "not a schema" }
    });

    expect(result).toBe(
      [
        "type BrokenInput = unknown",
        "type BrokenOutput = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Broken tool",
        "\t */",
        "\tbroken: (input: BrokenInput) => Promise<BrokenOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("should isolate errors: one throwing tool does not break others", () => {
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

    // The bad tool falls back to unknown types; good tools are unaffected
    expect(result).toBe(
      [
        "type Good1Input = {",
        "    a?: string;",
        "}",
        "type Good1Output = unknown",
        "type BadInput = unknown",
        "type BadOutput = unknown",
        "type Good2Input = {",
        "    b?: number;",
        "}",
        "type Good2Output = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Good first",
        "\t */",
        "\tgood1: (input: Good1Input) => Promise<Good1Output>;",
        "",
        "\t/**",
        "\t * Bad tool",
        "\t */",
        "\tbad: (input: BadInput) => Promise<BadOutput>;",
        "",
        "\t/**",
        "\t * Good second",
        "\t */",
        "\tgood2: (input: Good2Input) => Promise<Good2Output>;",
        "}"
      ].join("\n")
    );
  });
});
