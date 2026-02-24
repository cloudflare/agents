/**
 * Tests for codemode JSON Schema to TypeScript conversion.
 * Focus on our jsonSchemaToTypeString code, not zod-to-ts library.
 */
import { z } from "zod";
import { jsonSchema } from "ai";
import { describe, it, expect } from "vitest";
import { generateTypes } from "../types";
import type { ToolSet } from "ai";

// Helper: generateTypes accepts ToolDescriptors | ToolSet but jsonSchema() tools
// don't satisfy ToolDescriptors (Zod-typed). Cast via ToolSet for test convenience.
function genTypes(tools: Record<string, unknown>): string {
  return generateTypes(tools as unknown as ToolSet);
}

describe("generateTypes with jsonSchema wrapper", () => {
  it("handles simple object schema", () => {
    const tools = {
      getUser: {
        description: "Get a user",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            id: { type: "string" as const }
          },
          required: ["id"]
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type GetUserInput");
    expect(result).toContain("id: string;");
    expect(result).toContain("type GetUserOutput = unknown");
  });

  it("handles nested objects", () => {
    const tools = {
      createOrder: {
        description: "Create an order",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            user: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                email: { type: "string" as const }
              }
            }
          }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("user?:");
    expect(result).toContain("name?: string;");
    expect(result).toContain("email?: string;");
  });

  it("handles arrays", () => {
    const tools = {
      search: {
        description: "Search",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            tags: {
              type: "array" as const,
              items: { type: "string" as const }
            }
          }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("tags?: string[];");
  });

  it("handles enums", () => {
    const tools = {
      sort: {
        description: "Sort items",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            order: {
              type: "string" as const,
              enum: ["asc", "desc"]
            }
          }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('"asc" | "desc"');
  });

  it("handles required vs optional fields", () => {
    const tools = {
      query: {
        description: "Query data",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
            limit: { type: "number" as const }
          },
          required: ["query"]
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("query: string;");
    expect(result).toContain("limit?: number;");
  });

  it("handles descriptions in JSDoc", () => {
    const tools = {
      search: {
        description: "Search the web",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            query: { type: "string" as const, description: "Search query" },
            limit: { type: "number" as const, description: "Max results" }
          }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("/** Search query */");
    expect(result).toContain("/** Max results */");
    expect(result).toContain("@param input.query - Search query");
    expect(result).toContain("@param input.limit - Max results");
  });

  it("handles anyOf (union types)", () => {
    const tools = {
      getValue: {
        description: "Get value",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            value: {
              anyOf: [{ type: "string" as const }, { type: "number" as const }]
            }
          }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("string | number");
  });

  it("handles output schema", () => {
    const tools = {
      getWeather: {
        description: "Get weather",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            city: { type: "string" as const }
          }
        }),
        outputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            temperature: { type: "number" as const },
            conditions: { type: "string" as const }
          }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type GetWeatherOutput");
    expect(result).not.toContain("GetWeatherOutput = unknown");
    expect(result).toContain("temperature?: number;");
    expect(result).toContain("conditions?: string;");
  });
});

describe("generateTypes with Zod schema", () => {
  it("handles basic Zod object", () => {
    const tools = {
      getUser: {
        description: "Get a user",
        inputSchema: z.object({
          id: z.string()
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type GetUserInput");
    expect(result).toContain("id: string");
  });

  it("handles Zod descriptions", () => {
    const tools = {
      search: {
        description: "Search",
        inputSchema: z.object({
          query: z.string().describe("The search query")
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("/** The search query */");
    expect(result).toContain("@param input.query - The search query");
  });
});

describe("$ref resolution", () => {
  it("resolves $defs refs", () => {
    const tools = {
      create: {
        description: "Create",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            address: { $ref: "#/$defs/Address" }
          },
          $defs: {
            Address: {
              type: "object" as const,
              properties: {
                street: { type: "string" as const },
                city: { type: "string" as const }
              }
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("street?: string;");
    expect(result).toContain("city?: string;");
  });

  it("resolves definitions refs", () => {
    const tools = {
      create: {
        description: "Create",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            item: { $ref: "#/definitions/Item" }
          },
          definitions: {
            Item: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const }
              }
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("name?: string;");
  });

  it("returns unknown for unresolvable ref", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { $ref: "#/definitions/DoesNotExist" }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("val?: unknown;");
  });

  it("returns unknown for external URL ref", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { $ref: "https://example.com/schema.json" }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("val?: unknown;");
  });

  it("resolves nested ref chains", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            item: { $ref: "#/$defs/Wrapper" }
          },
          $defs: {
            Wrapper: {
              type: "object" as const,
              properties: {
                inner: { $ref: "#/$defs/Inner" }
              }
            },
            Inner: {
              type: "object" as const,
              properties: {
                value: { type: "number" as const }
              }
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("value?: number;");
  });
});

describe("circular schemas", () => {
  it("handles self-referencing $ref without stack overflow", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            child: { $ref: "#" }
          }
        } as Record<string, unknown>)
      }
    };

    // Should not throw
    const result = genTypes(tools);

    expect(result).toContain("type TestInput");
  });

  it("handles deeply nested schemas hitting depth limit", () => {
    // Build a schema 30 levels deep
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 30; i++) {
      schema = {
        type: "object",
        properties: { nested: schema }
      };
    }

    const tools = {
      deep: {
        description: "Deep",
        inputSchema: jsonSchema(schema)
      }
    };

    // Should not throw
    const result = genTypes(tools);

    expect(result).toContain("type DeepInput");
    // At some point it should hit the depth limit and emit `unknown`
    expect(result).toContain("unknown");
  });
});

describe("boolean property schemas", () => {
  it("maps true schema to unknown and false schema to never", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            anything: true,
            nothing: false
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("anything?: unknown;");
    expect(result).toContain("nothing?: never;");
  });
});

describe("property name safety", () => {
  it("escapes control characters in property names", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            "has\nnewline": { type: "string" as const },
            "has\ttab": { type: "string" as const }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("\\n");
    expect(result).toContain("\\t");
    expect(result).not.toContain("\n    has\n");
  });

  it("escapes quotes in property names", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            'has"quote': { type: "string" as const }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('\\"');
  });

  it("handles empty string property name", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            "": { type: "string" as const }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('""');
  });
});

describe("JSDoc safety", () => {
  it("escapes */ in property descriptions", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            field: {
              type: "string" as const,
              description: "Value like */ can break comments"
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("*\\/");
    expect(result).not.toContain("/** Value like */ can");
  });

  it("escapes */ in tool descriptions", () => {
    const tools = {
      test: {
        description: "A tool with */ in description",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { x: { type: "string" as const } }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("*\\/");
    expect(result).not.toMatch(/\* A tool with \*\/ in/);
  });
});

describe("tuple support", () => {
  it("handles items as array (draft-07 tuples)", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            pair: {
              type: "array" as const,
              items: [{ type: "string" as const }, { type: "number" as const }]
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("[string, number]");
  });

  it("handles prefixItems (JSON Schema 2020-12)", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            triple: {
              type: "array" as const,
              prefixItems: [
                { type: "string" as const },
                { type: "number" as const },
                { type: "boolean" as const }
              ]
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("[string, number, boolean]");
  });
});

describe("nullable support", () => {
  it("applies nullable: true to produce union with null", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            name: { type: "string" as const, nullable: true }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("string | null");
  });

  it("does not add null when nullable is not set", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            name: { type: "string" as const }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("name?: string;");
    expect(result).not.toContain("string | null");
  });
});

describe("allOf / oneOf", () => {
  it("handles allOf intersection types", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: {
              allOf: [
                {
                  type: "object" as const,
                  properties: { a: { type: "string" as const } }
                },
                {
                  type: "object" as const,
                  properties: { b: { type: "number" as const } }
                }
              ]
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain(" & ");
    expect(result).toContain("a?: string;");
    expect(result).toContain("b?: number;");
  });

  it("handles oneOf union types with 3+ members", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: {
              oneOf: [
                { type: "string" as const },
                { type: "number" as const },
                { type: "boolean" as const }
              ]
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("string | number | boolean");
  });
});

describe("enum/const escaping", () => {
  it("escapes special chars in enum strings", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: {
              type: "string" as const,
              enum: ['say "hello"', "back\\slash"]
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('say \\"hello\\"');
    expect(result).toContain("back\\\\slash");
  });

  it("handles null in enum", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { enum: ["a", null, "b"] }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('"a" | null | "b"');
  });

  it("escapes special chars in const", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { const: 'line "one"' }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('line \\"one\\"');
  });
});

describe("type array and integer mapping", () => {
  it('handles type array like ["string", "null"]', () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { type: ["string", "null"] }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("string | null");
  });

  it("maps integer to number", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            count: { type: "integer" as const }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("count?: number;");
  });

  it("handles bare array type without items", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            list: { type: "array" as const }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("list?: unknown[];");
  });

  it("handles empty enum as never", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { enum: [] }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("val?: never;");
  });
});

describe("additionalProperties", () => {
  it("emits index signature for additionalProperties: true", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            name: { type: "string" as const }
          },
          additionalProperties: true
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("name?: string;");
    expect(result).toContain("[key: string]: unknown;");
  });

  it("emits typed index signature for typed additionalProperties", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          additionalProperties: { type: "string" as const }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("[key: string]: string;");
  });
});

describe("additionalProperties: false", () => {
  it("returns empty object type when no properties and additionalProperties is false", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          additionalProperties: false
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("type TestInput = {}");
    expect(result).not.toContain("Record<string, unknown>");
  });

  it("returns Record<string, unknown> when no properties and no additionalProperties constraint", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("Record<string, unknown>");
  });
});

describe("enum/const object values", () => {
  it("serializes object enum values with JSON.stringify", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { enum: [{ key: "value" }, "plain"] }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('{"key":"value"}');
    expect(result).not.toContain("[object Object]");
  });

  it("serializes array enum values with JSON.stringify", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { enum: [[1, 2, 3], "plain"] }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("[1,2,3]");
    expect(result).not.toContain("[object Object]");
  });

  it("serializes object const values with JSON.stringify", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            val: { const: { nested: true } }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain('{"nested":true}');
  });
});

describe("multi-line JSDoc format", () => {
  it("uses multi-line JSDoc when both description and format are present", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            email: {
              type: "string" as const,
              description: "User email address",
              format: "email"
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("* User email address");
    expect(result).toContain("* @format email");
    // Should be multi-line, not single-line
    expect(result).not.toContain("/** User email address @format email */");
  });

  it("uses single-line JSDoc when only format is present", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            id: {
              type: "string" as const,
              format: "uuid"
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("/** @format uuid */");
  });
});

describe("newline normalization in descriptions", () => {
  it("normalizes newlines in property descriptions", () => {
    const tools = {
      test: {
        description: "Test",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            field: {
              type: "string" as const,
              description: "Line one\nLine two\r\nLine three"
            }
          }
        } as Record<string, unknown>)
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("/** Line one Line two Line three */");
    expect(result).not.toContain("Line one\n");
  });

  it("normalizes newlines in tool descriptions", () => {
    const tools = {
      test: {
        description: "Tool that does\nmultiple things\r\non multiple lines",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { x: { type: "string" as const } }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain(
      "Tool that does multiple things on multiple lines"
    );
  });
});

describe("generateTypes codemode declaration", () => {
  it("generates proper codemode declaration", () => {
    const tools = {
      tool1: {
        description: "First tool",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { a: { type: "string" as const } }
        })
      },
      tool2: {
        description: "Second tool",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { b: { type: "number" as const } }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("declare const codemode: {");
    expect(result).toContain(
      "tool1: (input: Tool1Input) => Promise<Tool1Output>;"
    );
    expect(result).toContain(
      "tool2: (input: Tool2Input) => Promise<Tool2Output>;"
    );
  });

  it("sanitizes tool names in declaration", () => {
    const tools = {
      "get-user": {
        description: "Get user",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: { id: { type: "string" as const } }
        })
      }
    };

    const result = genTypes(tools);

    expect(result).toContain("get_user: (input: GetUserInput)");
  });
});
