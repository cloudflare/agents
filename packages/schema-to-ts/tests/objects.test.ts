/**
 * Tests for object type conversion
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToTs } from "../src/convert.js";

describe("Object Types", () => {
  describe("basic objects", () => {
    it("simple object with properties", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("name?: string");
      expect(result).toContain("age?: number");
    });

    it("object with required properties", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" }
          },
          required: ["name"]
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("name: string");
      expect(result).toContain("age?: number");
    });

    it("object with all required properties", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" }
          },
          required: ["name", "age"]
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("name: string");
      expect(result).toContain("age: number");
      expect(result).not.toContain("?:");
    });

    it("empty object type", () => {
      const result = jsonSchemaToTs({ type: "object" }, { name: undefined });
      expect(result).toBe("Record<string, unknown>");
    });

    it("object with empty properties", () => {
      const result = jsonSchemaToTs(
        { type: "object", properties: {} },
        { name: undefined }
      );
      expect(result).toBe("{}");
    });
  });

  describe("additionalProperties", () => {
    it("additionalProperties: false", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("a?: string");
      expect(result).not.toContain("[key: string]");
    });

    it("additionalProperties: true", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: true
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("a?: string");
      expect(result).toContain("[key: string]: unknown");
    });

    it("additionalProperties with schema", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: { type: "number" }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("a?: string");
      expect(result).toContain("[key: string]: number");
    });

    it("only additionalProperties (Record type)", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          additionalProperties: { type: "string" }
        },
        { name: undefined }
      );
      expect(result).toBe("Record<string, string>");
    });
  });

  describe("nested objects", () => {
    it("one level nesting", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                name: { type: "string" }
              }
            }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("user?:");
      expect(result).toContain("name?: string");
    });

    it("deeply nested objects", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: {
                b: {
                  type: "object",
                  properties: {
                    c: { type: "string" }
                  }
                }
              }
            }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("a?:");
      expect(result).toContain("b?:");
      expect(result).toContain("c?: string");
    });
  });

  describe("property names", () => {
    it("handles valid identifiers", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            validName: { type: "string" },
            _private: { type: "string" },
            $special: { type: "string" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("validName?: string");
      expect(result).toContain("_private?: string");
      expect(result).toContain("$special?: string");
    });

    it("quotes invalid identifiers", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            "kebab-case": { type: "string" },
            "with spaces": { type: "string" },
            "123numeric": { type: "string" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain('"kebab-case"?: string');
      expect(result).toContain('"with spaces"?: string');
      expect(result).toContain('"123numeric"?: string');
    });
  });

  describe("descriptions", () => {
    it("includes property descriptions as comments", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string", description: "The user name" }
          }
        },
        { name: undefined, includeComments: true }
      );
      expect(result).toContain("/** The user name */");
    });

    it("skips comments when disabled", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string", description: "The user name" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).not.toContain("/**");
    });
  });
});
