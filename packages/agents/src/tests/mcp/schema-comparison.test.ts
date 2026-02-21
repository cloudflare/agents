/**
 * Tests comparing AI SDK jsonSchema() vs Zod v4 fromJSONSchema()
 *
 * KEY FINDING: The main difference is that fromJSONSchema() produces a real
 * Zod schema with _zod property, while jsonSchema() produces a Schema wrapper.
 * Both work for AI SDK tool definitions, but only fromJSONSchema() works with
 * zod-to-ts for codemode type generation.
 */
import { describe, it, expect } from "vitest";
import { jsonSchema } from "ai";
import { fromJSONSchema } from "zod/v4";
import type { ZodType } from "zod";

// Helper to check if a schema has _zod property (required for codemode)
function hasZodMarker(schema: unknown): boolean {
  return (schema as { _zod?: unknown })?._zod !== undefined;
}

describe("jsonSchema() vs fromJSONSchema() comparison", () => {
  describe("_zod property (required for codemode)", () => {
    it("fromJSONSchema has _zod property", () => {
      const schema = {
        type: "object" as const,
        properties: { name: { type: "string" as const } }
      };
      const result = fromJSONSchema(schema);
      expect(hasZodMarker(result)).toBe(true);
    });

    it("jsonSchema does NOT have _zod property", () => {
      const schema = {
        type: "object" as const,
        properties: { name: { type: "string" as const } }
      };
      const result = jsonSchema(schema);
      expect(hasZodMarker(result)).toBe(false);
    });
  });

  describe("fromJSONSchema validation behavior", () => {
    it("validates basic object with required fields", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          age: { type: "number" as const }
        },
        required: ["name"]
      });

      expect(schema.safeParse({ name: "John", age: 30 }).success).toBe(true);
      expect(schema.safeParse({ name: "John" }).success).toBe(true);
      expect(schema.safeParse({ age: 30 }).success).toBe(false); // missing name
    });

    it("validates nested objects", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          user: {
            type: "object" as const,
            properties: {
              name: { type: "string" as const },
              address: {
                type: "object" as const,
                properties: {
                  city: { type: "string" as const }
                }
              }
            }
          }
        }
      });

      expect(
        schema.safeParse({
          user: { name: "John", address: { city: "NYC" } }
        }).success
      ).toBe(true);
    });

    it("validates arrays", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          tags: {
            type: "array" as const,
            items: { type: "string" as const }
          }
        }
      });

      expect(schema.safeParse({ tags: ["a", "b", "c"] }).success).toBe(true);
      expect(schema.safeParse({ tags: [] }).success).toBe(true);
      expect(schema.safeParse({ tags: [1, 2, 3] }).success).toBe(false);
    });

    it("validates enums", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          status: {
            type: "string" as const,
            enum: ["pending", "active", "done"]
          }
        }
      });

      expect(schema.safeParse({ status: "active" }).success).toBe(true);
      expect(schema.safeParse({ status: "invalid" }).success).toBe(false);
    });

    it("validates booleans", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          enabled: { type: "boolean" as const }
        }
      });

      expect(schema.safeParse({ enabled: true }).success).toBe(true);
      expect(schema.safeParse({ enabled: false }).success).toBe(true);
      expect(schema.safeParse({ enabled: "true" }).success).toBe(false);
    });

    it("validates complex MCP-like schemas", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          query: { type: "string" as const },
          filters: {
            type: "object" as const,
            properties: {
              category: { type: "string" as const },
              minPrice: { type: "number" as const },
              tags: {
                type: "array" as const,
                items: { type: "string" as const }
              }
            }
          },
          pagination: {
            type: "object" as const,
            properties: {
              page: { type: "integer" as const },
              limit: { type: "integer" as const }
            }
          },
          sortBy: {
            type: "string" as const,
            enum: ["relevance", "price", "date"]
          }
        },
        required: ["query"]
      });

      // Full input
      expect(
        schema.safeParse({
          query: "test",
          filters: { category: "electronics", minPrice: 10, tags: ["new"] },
          pagination: { page: 1, limit: 20 },
          sortBy: "price"
        }).success
      ).toBe(true);

      // Minimal input (just required fields)
      expect(schema.safeParse({ query: "test" }).success).toBe(true);

      // Missing required field
      expect(schema.safeParse({ sortBy: "price" }).success).toBe(false);
    });
  });

  describe("Zod schema methods available", () => {
    it("fromJSONSchema result has parse method", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: { name: { type: "string" as const } }
      });

      expect(typeof schema.parse).toBe("function");
      expect(schema.parse({ name: "John" })).toEqual({ name: "John" });
    });

    it("fromJSONSchema result has safeParse method", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: { name: { type: "string" as const } }
      });

      expect(typeof schema.safeParse).toBe("function");
      const result = schema.safeParse({ name: "John" });
      expect(result.success).toBe(true);
    });

    it("fromJSONSchema result throws on invalid input with parse()", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: { age: { type: "number" as const } },
        required: ["age"]
      });

      expect(() => schema.parse({})).toThrow();
    });
  });

  describe("edge cases for MCP tools", () => {
    it("handles empty object schema", () => {
      const schema = fromJSONSchema({ type: "object" as const });
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ extra: "field" }).success).toBe(true);
    });

    it("handles schema with description (common in MCP)", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Search query string"
          }
        }
      });

      expect(schema.safeParse({ query: "test" }).success).toBe(true);
    });

    it("handles integer type", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          count: { type: "integer" as const }
        }
      });

      expect(schema.safeParse({ count: 5 }).success).toBe(true);
      expect(schema.safeParse({ count: 5.5 }).success).toBe(false);
    });

    it("handles array of objects", () => {
      const schema = fromJSONSchema({
        type: "object" as const,
        properties: {
          items: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                id: { type: "string" as const },
                value: { type: "number" as const }
              }
            }
          }
        }
      });

      expect(
        schema.safeParse({
          items: [
            { id: "a", value: 1 },
            { id: "b", value: 2 }
          ]
        }).success
      ).toBe(true);
    });
  });
});
