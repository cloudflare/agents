/**
 * Tests for composition types (anyOf, allOf, oneOf, not)
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToTs } from "../src/convert.js";

describe("Composition Types", () => {
  describe("anyOf (union)", () => {
    it("two primitive types", () => {
      const result = jsonSchemaToTs(
        { anyOf: [{ type: "string" }, { type: "number" }] },
        { name: undefined }
      );
      expect(result).toBe("string | number");
    });

    it("three types", () => {
      const result = jsonSchemaToTs(
        {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }]
        },
        { name: undefined }
      );
      expect(result).toBe("string | number | boolean");
    });

    it("single item unwraps", () => {
      const result = jsonSchemaToTs(
        { anyOf: [{ type: "string" }] },
        { name: undefined }
      );
      expect(result).toBe("string");
    });

    it("objects in union", () => {
      const result = jsonSchemaToTs(
        {
          anyOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } }
          ]
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("a?: string");
      expect(result).toContain("b?: number");
      expect(result).toContain("|");
    });

    it("deduplicates identical types", () => {
      const result = jsonSchemaToTs(
        { anyOf: [{ type: "string" }, { type: "string" }] },
        { name: undefined }
      );
      expect(result).toBe("string");
    });
  });

  describe("oneOf (exclusive union)", () => {
    it("behaves same as anyOf for types", () => {
      const result = jsonSchemaToTs(
        { oneOf: [{ type: "string" }, { type: "number" }] },
        { name: undefined }
      );
      expect(result).toBe("string | number");
    });
  });

  describe("allOf (intersection)", () => {
    it("two object types", () => {
      const result = jsonSchemaToTs(
        {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } }
          ]
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("&");
      expect(result).toContain("a?: string");
      expect(result).toContain("b?: number");
    });

    it("single item unwraps", () => {
      const result = jsonSchemaToTs(
        { allOf: [{ type: "string" }] },
        { name: undefined }
      );
      expect(result).toBe("string");
    });

    it("intersection with primitives", () => {
      const result = jsonSchemaToTs(
        { allOf: [{ type: "string" }, { type: "number" }] },
        { name: undefined }
      );
      // This is technically never in TS, but we just output the intersection
      expect(result).toBe("string & number");
    });
  });

  describe("not", () => {
    it("not becomes unknown (cannot represent in TS)", () => {
      const result = jsonSchemaToTs(
        { not: { type: "string" } },
        { name: undefined }
      );
      expect(result).toBe("unknown");
    });
  });

  describe("if/then/else", () => {
    it("if/then/else becomes union of then and else", () => {
      const result = jsonSchemaToTs(
        {
          if: { type: "string" },
          then: { type: "string", minLength: 1 },
          else: { type: "number" }
        },
        { name: undefined }
      );
      expect(result).toBe("string | number");
    });

    it("if/then without else", () => {
      const result = jsonSchemaToTs(
        {
          if: { type: "string" },
          then: { type: "string" }
        },
        { name: undefined }
      );
      expect(result).toBe("string");
    });
  });

  describe("nested composition", () => {
    it("anyOf inside allOf", () => {
      const result = jsonSchemaToTs(
        {
          allOf: [
            { anyOf: [{ type: "string" }, { type: "number" }] },
            { type: "object", properties: { x: { type: "boolean" } } }
          ]
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("(string | number)");
      expect(result).toContain("&");
    });
  });
});
