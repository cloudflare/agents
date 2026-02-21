/**
 * Tests for array type conversion
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToTs } from "../src/convert.js";

describe("Array Types", () => {
  describe("basic arrays", () => {
    it("array of strings", () => {
      const result = jsonSchemaToTs(
        { type: "array", items: { type: "string" } },
        { name: undefined }
      );
      expect(result).toBe("string[]");
    });

    it("array of numbers", () => {
      const result = jsonSchemaToTs(
        { type: "array", items: { type: "number" } },
        { name: undefined }
      );
      expect(result).toBe("number[]");
    });

    it("array of booleans", () => {
      const result = jsonSchemaToTs(
        { type: "array", items: { type: "boolean" } },
        { name: undefined }
      );
      expect(result).toBe("boolean[]");
    });

    it("array without items", () => {
      const result = jsonSchemaToTs({ type: "array" }, { name: undefined });
      expect(result).toBe("unknown[]");
    });
  });

  describe("array of objects", () => {
    it("array of simple objects", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              value: { type: "number" }
            }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("id?: string");
      expect(result).toContain("value?: number");
      expect(result).toContain("[]");
    });
  });

  describe("array of unions", () => {
    it("array of string | number", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] }
        },
        { name: undefined }
      );
      expect(result).toBe("(string | number)[]");
    });
  });

  describe("tuples", () => {
    it("tuple with prefixItems", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }]
        },
        { name: undefined }
      );
      expect(result).toBe("[string, number]");
    });

    it("tuple with three items", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" }
          ]
        },
        { name: undefined }
      );
      expect(result).toBe("[string, number, boolean]");
    });

    it("tuple with rest items", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "number" }
        },
        { name: undefined }
      );
      expect(result).toBe("[string, ...number[]]");
    });

    it("tuple with items array (legacy)", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          items: [{ type: "string" }, { type: "number" }]
        },
        { name: undefined }
      );
      expect(result).toBe("[string, number]");
    });
  });

  describe("nested arrays", () => {
    it("array of arrays", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" }
          }
        },
        { name: undefined }
      );
      expect(result).toBe("string[][]");
    });

    it("deeply nested arrays", () => {
      const result = jsonSchemaToTs(
        {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array",
              items: { type: "number" }
            }
          }
        },
        { name: undefined }
      );
      expect(result).toBe("number[][][]");
    });
  });
});
