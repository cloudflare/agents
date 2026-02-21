/**
 * Tests for schema detection utilities
 */
import { describe, it, expect } from "vitest";
import { jsonSchema } from "ai";
import { z } from "zod";
import {
  isZodSchema,
  isJsonSchemaWrapper,
  isRawJsonSchema,
  extractJsonSchema
} from "../src/detect.js";

describe("Schema Detection", () => {
  describe("isZodSchema", () => {
    it("returns true for zod object schema", () => {
      const schema = z.object({ name: z.string() });
      expect(isZodSchema(schema)).toBe(true);
    });

    it("returns true for zod string schema", () => {
      const schema = z.string();
      expect(isZodSchema(schema)).toBe(true);
    });

    it("returns true for zod array schema", () => {
      const schema = z.array(z.number());
      expect(isZodSchema(schema)).toBe(true);
    });

    it("returns false for raw JSON Schema", () => {
      const schema = { type: "object", properties: {} };
      expect(isZodSchema(schema)).toBe(false);
    });

    it("returns false for jsonSchema wrapper", () => {
      const schema = jsonSchema({ type: "object" });
      expect(isZodSchema(schema)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isZodSchema(null)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isZodSchema("string")).toBe(false);
      expect(isZodSchema(123)).toBe(false);
      expect(isZodSchema(true)).toBe(false);
    });
  });

  describe("isJsonSchemaWrapper", () => {
    it("returns true for jsonSchema wrapper", () => {
      const schema = jsonSchema({ type: "object" });
      expect(isJsonSchemaWrapper(schema)).toBe(true);
    });

    it("returns true for jsonSchema with properties", () => {
      const schema = jsonSchema({
        type: "object",
        properties: { name: { type: "string" } }
      });
      expect(isJsonSchemaWrapper(schema)).toBe(true);
    });

    it("returns false for raw JSON Schema", () => {
      const schema = { type: "object", properties: {} };
      expect(isJsonSchemaWrapper(schema)).toBe(false);
    });

    it("returns false for zod schema", () => {
      const schema = z.object({ name: z.string() });
      expect(isJsonSchemaWrapper(schema)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isJsonSchemaWrapper(null)).toBe(false);
    });
  });

  describe("isRawJsonSchema", () => {
    it("returns true for schema with type", () => {
      const schema = { type: "object" };
      expect(isRawJsonSchema(schema)).toBe(true);
    });

    it("returns true for schema with properties", () => {
      const schema = { properties: { name: { type: "string" } } };
      expect(isRawJsonSchema(schema)).toBe(true);
    });

    it("returns true for empty schema", () => {
      expect(isRawJsonSchema({})).toBe(true);
    });

    it("returns true for schema with anyOf", () => {
      const schema = { anyOf: [{ type: "string" }] };
      expect(isRawJsonSchema(schema)).toBe(true);
    });

    it("returns false for zod schema", () => {
      const schema = z.object({ name: z.string() });
      expect(isRawJsonSchema(schema)).toBe(false);
    });

    it("returns false for jsonSchema wrapper", () => {
      const schema = jsonSchema({ type: "object" });
      expect(isRawJsonSchema(schema)).toBe(false);
    });
  });

  describe("extractJsonSchema", () => {
    it("extracts from raw JSON Schema", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } }
      };
      const result = extractJsonSchema(schema);
      expect(result).toEqual(schema);
    });

    it("extracts from jsonSchema wrapper", () => {
      const inner = {
        type: "object",
        properties: { name: { type: "string" } }
      };
      const schema = jsonSchema(inner);
      const result = extractJsonSchema(schema);
      expect(result).toEqual(inner);
    });

    it("throws for unsupported types", () => {
      expect(() => extractJsonSchema("not a schema")).toThrow();
      expect(() => extractJsonSchema(123)).toThrow();
      expect(() => extractJsonSchema(null)).toThrow();
    });
  });
});
