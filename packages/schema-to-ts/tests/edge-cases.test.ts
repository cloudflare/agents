/**
 * Edge case tests for schema-to-ts
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToTs } from "../src/convert.js";
import { schemaToTs } from "../src/schema-to-ts.js";
import { jsonSchema } from "ai";

describe("Edge Cases", () => {
  describe("empty and boolean schemas", () => {
    it("empty object schema returns unknown", () => {
      const result = jsonSchemaToTs({}, { name: undefined });
      expect(result).toBe("unknown");
    });

    it("true schema returns unknown", () => {
      const result = jsonSchemaToTs(true as any, { name: undefined });
      expect(result).toBe("unknown");
    });

    it("false schema returns never", () => {
      const result = jsonSchemaToTs(false as any, { name: undefined });
      expect(result).toBe("never");
    });
  });

  describe("deeply nested schemas", () => {
    it("handles 5 levels of nesting", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            l1: {
              type: "object",
              properties: {
                l2: {
                  type: "object",
                  properties: {
                    l3: {
                      type: "object",
                      properties: {
                        l4: {
                          type: "object",
                          properties: {
                            l5: { type: "string" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("l1?:");
      expect(result).toContain("l2?:");
      expect(result).toContain("l3?:");
      expect(result).toContain("l4?:");
      expect(result).toContain("l5?: string");
    });

    it("handles 10 levels of array nesting", () => {
      let schema: any = { type: "string" };
      for (let i = 0; i < 10; i++) {
        schema = { type: "array", items: schema };
      }
      const result = jsonSchemaToTs(schema, { name: undefined });
      expect(result).toBe("string[][][][][][][][][][]");
    });
  });

  describe("wide objects", () => {
    it("handles object with 20 properties", () => {
      const properties: Record<string, any> = {};
      for (let i = 0; i < 20; i++) {
        properties[`prop${i}`] = { type: "string" };
      }
      const result = jsonSchemaToTs(
        { type: "object", properties },
        { name: undefined, includeComments: false }
      );
      for (let i = 0; i < 20; i++) {
        expect(result).toContain(`prop${i}?: string`);
      }
    });
  });

  describe("complex unions and intersections", () => {
    it("handles union of 5 types", () => {
      const result = jsonSchemaToTs(
        {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "null" },
            { type: "array", items: { type: "string" } }
          ]
        },
        { name: undefined }
      );
      expect(result).toContain("string");
      expect(result).toContain("number");
      expect(result).toContain("boolean");
      expect(result).toContain("null");
      expect(result).toContain("string[]");
    });

    it("handles intersection of 3 object types", () => {
      const result = jsonSchemaToTs(
        {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
            { type: "object", properties: { c: { type: "boolean" } } }
          ]
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("&");
      expect(result).toContain("a?: string");
      expect(result).toContain("b?: number");
      expect(result).toContain("c?: boolean");
    });
  });

  describe("special property names", () => {
    it("handles reserved TypeScript keywords as property names", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            class: { type: "string" },
            function: { type: "string" },
            interface: { type: "string" },
            type: { type: "string" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("class?: string");
      expect(result).toContain("function?: string");
      expect(result).toContain("interface?: string");
      expect(result).toContain("type?: string");
    });

    it("handles unicode property names", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            日本語: { type: "string" },
            "emoji🎉": { type: "string" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain('"日本語"?: string');
      expect(result).toContain('"emoji🎉"?: string');
    });

    it("handles numeric property names", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            "0": { type: "string" },
            "123": { type: "number" }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain('"0"?: string');
      expect(result).toContain('"123"?: number');
    });
  });

  describe("enum edge cases", () => {
    it("handles empty enum", () => {
      const result = jsonSchemaToTs({ enum: [] }, { name: undefined });
      expect(result).toBe("");
    });

    it("handles enum with object values", () => {
      const result = jsonSchemaToTs(
        { enum: [{ a: 1 }, { b: 2 }] },
        { name: undefined }
      );
      expect(result).toContain('{"a":1}');
      expect(result).toContain('{"b":2}');
    });

    it("handles enum with array values", () => {
      const result = jsonSchemaToTs(
        {
          enum: [
            [1, 2],
            [3, 4]
          ]
        },
        { name: undefined }
      );
      expect(result).toContain("[1,2]");
      expect(result).toContain("[3,4]");
    });
  });

  describe("with jsonSchema() wrapper", () => {
    it("handles complex nested schema through wrapper", () => {
      const schema = jsonSchema({
        type: "object",
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                nested: {
                  type: "object",
                  properties: {
                    value: { type: "number" }
                  }
                }
              }
            }
          }
        }
      });

      const result = schemaToTs(schema, {
        name: "ComplexData",
        includeComments: false
      });
      expect(result).toContain("type ComplexData =");
      expect(result).toContain("data?:");
      expect(result).toContain("id?: string");
      expect(result).toContain("nested?:");
      expect(result).toContain("value?: number");
    });
  });

  describe("const with complex types", () => {
    it("handles const with nested object", () => {
      const result = jsonSchemaToTs(
        { const: { nested: { value: 42 } } },
        { name: undefined }
      );
      expect(result).toBe('{"nested":{"value":42}}');
    });

    it("handles const with array", () => {
      const result = jsonSchemaToTs({ const: [1, 2, 3] }, { name: undefined });
      expect(result).toBe("[1,2,3]");
    });
  });

  describe("descriptions and comments", () => {
    it("includes top-level description", () => {
      const result = jsonSchemaToTs(
        { type: "string", description: "A user's name" },
        { name: "UserName", includeComments: true }
      );
      expect(result).toContain("/** A user's name */");
      expect(result).toContain("type UserName =");
    });

    it("includes nested property descriptions", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string", description: "The name" },
            age: { type: "number", description: "The age" }
          }
        },
        { name: "User", includeComments: true }
      );
      expect(result).toContain("/** The name */");
      expect(result).toContain("/** The age */");
    });
  });
});
