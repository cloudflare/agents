/**
 * Integration tests - schemaToTs with different schema types
 */
import { describe, it, expect } from "vitest";
import { jsonSchema } from "ai";
import { z } from "zod";
import { schemaToTs } from "../src/schema-to-ts.js";

describe("schemaToTs Integration", () => {
  describe("with raw JSON Schema", () => {
    it("converts simple object", () => {
      const result = schemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" }
          },
          required: ["name"]
        },
        { name: "User", includeComments: false }
      );
      expect(result).toContain("type User =");
      expect(result).toContain("name: string");
      expect(result).toContain("age?: number");
    });
  });

  describe("with AI SDK jsonSchema()", () => {
    it("converts jsonSchema wrapper", () => {
      const schema = jsonSchema({
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" }
        },
        required: ["query"]
      });

      const result = schemaToTs(schema, {
        name: "SearchParams",
        includeComments: false
      });
      expect(result).toContain("type SearchParams =");
      expect(result).toContain("query: string");
      expect(result).toContain("limit?: number");
    });

    it("converts complex MCP-like schema", () => {
      const schema = jsonSchema({
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "delete"]
          },
          data: {
            type: "object",
            properties: {
              id: { type: "string" },
              fields: {
                type: "array",
                items: { type: "string" }
              }
            }
          }
        },
        required: ["action"]
      });

      const result = schemaToTs(schema, {
        name: "Command",
        includeComments: false
      });
      expect(result).toContain("type Command =");
      expect(result).toContain('action: "create" | "update" | "delete"');
      expect(result).toContain("data?:");
      expect(result).toContain("id?: string");
      expect(result).toContain("fields?: string[]");
    });
  });

  describe("both paths produce equivalent output", () => {
    it("simple string schema", () => {
      const rawResult = schemaToTs({ type: "string" }, { name: undefined });
      const wrappedResult = schemaToTs(jsonSchema({ type: "string" }), {
        name: undefined
      });
      expect(rawResult).toBe(wrappedResult);
    });

    it("object with properties", () => {
      const schema = {
        type: "object" as const,
        properties: {
          name: { type: "string" as const }
        }
      };

      const rawResult = schemaToTs(schema, {
        name: "Test",
        includeComments: false
      });
      const wrappedResult = schemaToTs(jsonSchema(schema), {
        name: "Test",
        includeComments: false
      });
      expect(rawResult).toBe(wrappedResult);
    });

    it("array of objects", () => {
      const schema = {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const }
          }
        }
      };

      const rawResult = schemaToTs(schema, {
        name: "Items",
        includeComments: false
      });
      const wrappedResult = schemaToTs(jsonSchema(schema), {
        name: "Items",
        includeComments: false
      });
      expect(rawResult).toBe(wrappedResult);
    });
  });

  describe("real-world MCP tool schemas", () => {
    it("search tool schema", () => {
      const schema = jsonSchema({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string"
          },
          filters: {
            type: "object",
            properties: {
              category: { type: "string" },
              minPrice: { type: "number" },
              maxPrice: { type: "number" }
            }
          },
          pagination: {
            type: "object",
            properties: {
              page: { type: "integer" },
              limit: { type: "integer" }
            }
          }
        },
        required: ["query"]
      });

      const result = schemaToTs(schema, { name: "SearchInput" });
      expect(result).toContain("type SearchInput =");
      expect(result).toContain("query: string");
      expect(result).toContain("filters?:");
      expect(result).toContain("pagination?:");
    });

    it("code execution tool schema", () => {
      const schema = jsonSchema({
        type: "object",
        properties: {
          code: { type: "string" },
          language: {
            type: "string",
            enum: ["javascript", "python", "typescript"]
          },
          timeout: { type: "integer" }
        },
        required: ["code", "language"]
      });

      const result = schemaToTs(schema, {
        name: "ExecuteCodeInput",
        includeComments: false
      });
      expect(result).toContain("code: string");
      expect(result).toContain(
        'language: "javascript" | "python" | "typescript"'
      );
      expect(result).toContain("timeout?: number");
    });
  });
});
