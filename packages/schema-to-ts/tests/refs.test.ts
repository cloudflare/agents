/**
 * Tests for $ref handling
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaToTs } from "../src/convert.js";

describe("$ref handling", () => {
  describe("$defs references", () => {
    it("resolves simple $ref to $defs", () => {
      const result = jsonSchemaToTs(
        {
          $ref: "#/$defs/User",
          $defs: {
            User: {
              type: "object",
              properties: {
                name: { type: "string" }
              }
            }
          }
        },
        { name: undefined, includeComments: false }
      );
      expect(result).toContain("type User =");
      expect(result).toContain("name?: string");
    });

    it("generates named type for referenced schema", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            user: { $ref: "#/$defs/User" }
          },
          $defs: {
            User: {
              type: "object",
              properties: {
                name: { type: "string" }
              }
            }
          }
        },
        { name: "Root", includeComments: false }
      );
      expect(result).toContain("type User =");
      expect(result).toContain("user?: User");
    });

    it("handles multiple refs to same definition", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            author: { $ref: "#/$defs/Person" },
            reviewer: { $ref: "#/$defs/Person" }
          },
          $defs: {
            Person: {
              type: "object",
              properties: {
                name: { type: "string" }
              }
            }
          }
        },
        { name: "Document", includeComments: false }
      );
      // Should only generate Person type once
      const personMatches = result.match(/type Person =/g);
      expect(personMatches).toHaveLength(1);
      expect(result).toContain("author?: Person");
      expect(result).toContain("reviewer?: Person");
    });
  });

  describe("recursive refs", () => {
    it("handles self-referential schema", () => {
      const result = jsonSchemaToTs(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/$defs/Node" }
            }
          },
          $defs: {
            Node: {
              type: "object",
              properties: {
                name: { type: "string" },
                children: {
                  type: "array",
                  items: { $ref: "#/$defs/Node" }
                }
              }
            }
          }
        },
        { name: "Tree", includeComments: false }
      );
      expect(result).toContain("type Node =");
      expect(result).toContain("children?: Node[]");
    });
  });

  describe("external refs", () => {
    it("returns unknown for external refs", () => {
      const result = jsonSchemaToTs(
        { $ref: "https://example.com/schema.json" },
        { name: undefined }
      );
      expect(result).toBe("unknown");
    });
  });
});
