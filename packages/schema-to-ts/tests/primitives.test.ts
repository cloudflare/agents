/**
 * Tests for primitive type conversion
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToTs } from "../src/convert.js";

describe("Primitive Types", () => {
  describe("string", () => {
    it("converts basic string type", () => {
      const result = jsonSchemaToTs({ type: "string" }, { name: undefined });
      expect(result).toBe("string");
    });

    it("string with format is still string", () => {
      const result = jsonSchemaToTs(
        { type: "string", format: "email" },
        { name: undefined }
      );
      expect(result).toBe("string");
    });

    it("string with pattern is still string", () => {
      const result = jsonSchemaToTs(
        { type: "string", pattern: "^[a-z]+$" },
        { name: undefined }
      );
      expect(result).toBe("string");
    });
  });

  describe("number", () => {
    it("converts number type", () => {
      const result = jsonSchemaToTs({ type: "number" }, { name: undefined });
      expect(result).toBe("number");
    });

    it("converts integer to number", () => {
      const result = jsonSchemaToTs({ type: "integer" }, { name: undefined });
      expect(result).toBe("number");
    });

    it("number with constraints is still number", () => {
      const result = jsonSchemaToTs(
        { type: "number", minimum: 0, maximum: 100 },
        { name: undefined }
      );
      expect(result).toBe("number");
    });
  });

  describe("boolean", () => {
    it("converts boolean type", () => {
      const result = jsonSchemaToTs({ type: "boolean" }, { name: undefined });
      expect(result).toBe("boolean");
    });
  });

  describe("null", () => {
    it("converts null type", () => {
      const result = jsonSchemaToTs({ type: "null" }, { name: undefined });
      expect(result).toBe("null");
    });
  });

  describe("unknown/any", () => {
    it("empty schema becomes unknown", () => {
      const result = jsonSchemaToTs({}, { name: undefined });
      expect(result).toBe("unknown");
    });

    it("no type specified becomes unknown", () => {
      const result = jsonSchemaToTs(
        { description: "test" },
        { name: undefined }
      );
      expect(result).toBe("unknown");
    });

    it("can use 'any' instead of 'unknown'", () => {
      const result = jsonSchemaToTs(
        {},
        { name: undefined, unknownType: "any" }
      );
      expect(result).toBe("any");
    });
  });
});

describe("Literal Types", () => {
  describe("const", () => {
    it("string const becomes literal", () => {
      const result = jsonSchemaToTs({ const: "foo" }, { name: undefined });
      expect(result).toBe('"foo"');
    });

    it("number const becomes literal", () => {
      const result = jsonSchemaToTs({ const: 42 }, { name: undefined });
      expect(result).toBe("42");
    });

    it("boolean true const", () => {
      const result = jsonSchemaToTs({ const: true }, { name: undefined });
      expect(result).toBe("true");
    });

    it("boolean false const", () => {
      const result = jsonSchemaToTs({ const: false }, { name: undefined });
      expect(result).toBe("false");
    });

    it("null const", () => {
      const result = jsonSchemaToTs({ const: null }, { name: undefined });
      expect(result).toBe("null");
    });
  });

  describe("enum", () => {
    it("string enum becomes union", () => {
      const result = jsonSchemaToTs(
        { enum: ["a", "b", "c"] },
        { name: undefined }
      );
      expect(result).toBe('"a" | "b" | "c"');
    });

    it("number enum becomes union", () => {
      const result = jsonSchemaToTs({ enum: [1, 2, 3] }, { name: undefined });
      expect(result).toBe("1 | 2 | 3");
    });

    it("mixed enum becomes union", () => {
      const result = jsonSchemaToTs(
        { enum: ["a", 1, null, true] },
        { name: undefined }
      );
      expect(result).toBe('"a" | 1 | null | true');
    });

    it("single value enum", () => {
      const result = jsonSchemaToTs({ enum: ["only"] }, { name: undefined });
      expect(result).toBe('"only"');
    });
  });
});

describe("Nullable Types", () => {
  it("type array with null becomes union", () => {
    const result = jsonSchemaToTs(
      { type: ["string", "null"] },
      { name: undefined }
    );
    expect(result).toBe("string | null");
  });

  it("multiple types become union", () => {
    const result = jsonSchemaToTs(
      { type: ["string", "number"] },
      { name: undefined }
    );
    expect(result).toBe("string | number");
  });

  it("three types become union", () => {
    const result = jsonSchemaToTs(
      { type: ["string", "number", "boolean"] },
      { name: undefined }
    );
    expect(result).toBe("string | number | boolean");
  });

  it("OpenAPI nullable: true adds null to type", () => {
    const result = jsonSchemaToTs(
      { type: "string", nullable: true },
      { name: undefined }
    );
    expect(result).toBe("string | null");
  });

  it("nullable: true with number", () => {
    const result = jsonSchemaToTs(
      { type: "number", nullable: true },
      { name: undefined }
    );
    expect(result).toBe("number | null");
  });

  it("nullable: true with object", () => {
    const result = jsonSchemaToTs(
      {
        type: "object",
        properties: { name: { type: "string" } },
        nullable: true
      },
      { name: undefined, includeComments: false }
    );
    expect(result).toContain("| null");
    expect(result).toContain("name?: string");
  });
});
