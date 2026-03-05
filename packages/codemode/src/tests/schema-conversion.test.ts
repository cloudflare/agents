/**
 * Tests for codemode JSON Schema to TypeScript conversion.
 * Dual tests verify both JSON Schema and Zod paths produce identical output
 * through jsonSchemaToTypeString().
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

/**
 * Generates two it() blocks — one using jsonSchema() wrapper, one using Zod —
 * running the same assertions against both. Ensures both schema paths produce
 * identical TypeScript output.
 */
function testBoth(
  name: string,
  toolName: string,
  schemas: { json: Record<string, unknown>; zod: z.ZodType },
  assertions: (result: string) => void,
  options?: {
    description?: string;
    outputSchemas?: { json: Record<string, unknown>; zod: z.ZodType };
  }
): void {
  const desc = options?.description ?? "Test";

  it(`${name} (JSON Schema)`, () => {
    const tools: Record<string, unknown> = {
      [toolName]: {
        description: desc,
        inputSchema: jsonSchema(schemas.json),
        ...(options?.outputSchemas
          ? { outputSchema: jsonSchema(options.outputSchemas.json) }
          : {})
      }
    };
    assertions(genTypes(tools));
  });

  it(`${name} (Zod)`, () => {
    const tools: Record<string, unknown> = {
      [toolName]: {
        description: desc,
        inputSchema: schemas.zod,
        ...(options?.outputSchemas
          ? { outputSchema: options.outputSchemas.zod }
          : {})
      }
    };
    assertions(genTypes(tools));
  });
}

// ---------------------------------------------------------------------------
// 1. Basic types (dual)
// ---------------------------------------------------------------------------

describe("basic types", () => {
  testBoth(
    "simple object with required field",
    "getUser",
    {
      json: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      zod: z.object({ id: z.string() })
    },
    (result) => {
      expect(result).toContain("type GetUserInput");
      expect(result).toContain("id: string;");
      expect(result).toContain("type GetUserOutput = unknown");
    },
    { description: "Get a user" }
  );

  testBoth(
    "nested objects",
    "createOrder",
    {
      json: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" }
            }
          }
        }
      },
      zod: z.object({
        user: z
          .object({
            name: z.string().optional(),
            email: z.string().optional()
          })
          .optional()
      })
    },
    (result) => {
      expect(result).toContain("user?:");
      expect(result).toContain("name?: string;");
      expect(result).toContain("email?: string;");
    },
    { description: "Create an order" }
  );

  testBoth(
    "arrays",
    "search",
    {
      json: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } }
        }
      },
      zod: z.object({
        tags: z.array(z.string()).optional()
      })
    },
    (result) => {
      expect(result).toContain("tags?: string[];");
    },
    { description: "Search" }
  );

  testBoth(
    "string enums",
    "sort",
    {
      json: {
        type: "object",
        properties: {
          order: { type: "string", enum: ["asc", "desc"] }
        }
      },
      zod: z.object({
        order: z.enum(["asc", "desc"]).optional()
      })
    },
    (result) => {
      expect(result).toContain('"asc" | "desc"');
    },
    { description: "Sort items" }
  );

  testBoth(
    "required vs optional fields",
    "query",
    {
      json: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" }
        },
        required: ["query"]
      },
      zod: z.object({
        query: z.string(),
        limit: z.number().optional()
      })
    },
    (result) => {
      expect(result).toContain("query: string;");
      expect(result).toContain("limit?: number;");
    },
    { description: "Query data" }
  );
});

// ---------------------------------------------------------------------------
// 2. Descriptions and JSDoc (dual + JSON-only)
// ---------------------------------------------------------------------------

describe("descriptions and JSDoc", () => {
  testBoth(
    "field descriptions in JSDoc and @param",
    "search",
    {
      json: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results" }
        }
      },
      zod: z.object({
        query: z.string().describe("Search query").optional(),
        limit: z.number().describe("Max results").optional()
      })
    },
    (result) => {
      expect(result).toContain("/** Search query */");
      expect(result).toContain("/** Max results */");
      expect(result).toContain("@param input.query - Search query");
      expect(result).toContain("@param input.limit - Max results");
    },
    { description: "Search the web" }
  );

  testBoth(
    "newline normalization in tool descriptions",
    "test",
    {
      json: {
        type: "object",
        properties: { x: { type: "string" } }
      },
      zod: z.object({ x: z.string().optional() })
    },
    (result) => {
      expect(result).toContain(
        "Tool that does multiple things on multiple lines"
      );
    },
    { description: "Tool that does\nmultiple things\r\non multiple lines" }
  );

  testBoth(
    "newline normalization in field descriptions",
    "test",
    {
      json: {
        type: "object",
        properties: {
          field: {
            type: "string",
            description: "Line one\nLine two\r\nLine three"
          }
        }
      },
      zod: z.object({
        field: z
          .string()
          .describe("Line one\nLine two\r\nLine three")
          .optional()
      })
    },
    (result) => {
      expect(result).toContain("/** Line one Line two Line three */");
      expect(result).not.toContain("Line one\n");
    }
  );

  it("escapes */ in property descriptions (JSON-only)", () => {
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

  it("escapes */ in tool descriptions (JSON-only)", () => {
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

  it("uses multi-line JSDoc when both description and format are present (JSON-only)", () => {
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
    expect(result).not.toContain("/** User email address @format email */");
  });

  it("uses single-line JSDoc when only format is present (JSON-only)", () => {
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

// ---------------------------------------------------------------------------
// 3. Unions and intersections (dual + JSON-only)
// ---------------------------------------------------------------------------

describe("unions and intersections", () => {
  testBoth(
    "anyOf union types",
    "getValue",
    {
      json: {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "number" }]
          }
        }
      },
      zod: z.object({
        value: z.union([z.string(), z.number()]).optional()
      })
    },
    (result) => {
      expect(result).toContain("string | number");
    },
    { description: "Get value" }
  );

  testBoth(
    "nullable field via anyOf with null",
    "test",
    {
      json: {
        type: "object",
        properties: {
          name: {
            anyOf: [{ type: "string" }, { type: "null" }]
          }
        }
      },
      zod: z.object({
        name: z.string().nullable().optional()
      })
    },
    (result) => {
      expect(result).toContain("string | null");
    }
  );

  it("handles allOf intersection types (JSON-only)", () => {
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

  it("handles oneOf union types with 3+ members (JSON-only)", () => {
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

// ---------------------------------------------------------------------------
// 4. Output schemas (dual)
// ---------------------------------------------------------------------------

describe("output schemas", () => {
  testBoth(
    "typed output schema",
    "getWeather",
    {
      json: {
        type: "object",
        properties: { city: { type: "string" } }
      },
      zod: z.object({ city: z.string().optional() })
    },
    (result) => {
      expect(result).toContain("type GetWeatherOutput");
      expect(result).not.toContain("GetWeatherOutput = unknown");
      expect(result).toContain("temperature?: number;");
      expect(result).toContain("conditions?: string;");
    },
    {
      description: "Get weather",
      outputSchemas: {
        json: {
          type: "object",
          properties: {
            temperature: { type: "number" },
            conditions: { type: "string" }
          }
        },
        zod: z.object({
          temperature: z.number().optional(),
          conditions: z.string().optional()
        })
      }
    }
  );

  testBoth(
    "complex input+output schemas",
    "getWeather",
    {
      json: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          units: { type: "string", enum: ["celsius", "fahrenheit"] }
        },
        required: ["city"]
      },
      zod: z.object({
        city: z.string().describe("City name"),
        units: z.enum(["celsius", "fahrenheit"]).optional()
      })
    },
    (result) => {
      // Input
      expect(result).toContain("type GetWeatherInput");
      expect(result).toContain("city: string");
      expect(result).toContain("units?:");
      expect(result).toContain('"celsius"');
      expect(result).toContain('"fahrenheit"');

      // Output
      expect(result).toContain("type GetWeatherOutput");
      expect(result).not.toContain("GetWeatherOutput = unknown");
      expect(result).toContain("temperature");
      expect(result).toContain("conditions");
      expect(result).toContain("forecast?:");
      expect(result).toContain("day?: string");
      expect(result).toContain("high?: number");
      expect(result).toContain("low?: number");

      // JSDoc
      expect(result).toContain("@param input.city - City name");
    },
    {
      description: "Get weather for a city",
      outputSchemas: {
        json: {
          type: "object",
          properties: {
            temperature: { type: "number" },
            conditions: { type: "string" },
            forecast: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  day: { type: "string" },
                  high: { type: "number" },
                  low: { type: "number" }
                }
              }
            }
          },
          required: ["temperature", "conditions"]
        },
        zod: z.object({
          temperature: z.number(),
          conditions: z.string(),
          forecast: z
            .array(
              z.object({
                day: z.string().optional(),
                high: z.number().optional(),
                low: z.number().optional()
              })
            )
            .optional()
        })
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 5. $ref resolution (JSON-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 6. Circular schemas (JSON-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7. Edge cases (JSON-only)
// ---------------------------------------------------------------------------

describe("edge cases", () => {
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

  it("applies OpenAPI nullable: true to produce union with null", () => {
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
});

// ---------------------------------------------------------------------------
// 8. Property name safety (JSON-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 9. Enum/const values (JSON-only)
// ---------------------------------------------------------------------------

describe("enum/const values", () => {
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

// ---------------------------------------------------------------------------
// 10. additionalProperties (JSON-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 11. Tuple support (JSON-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 12. Codemode declaration (dual + JSON-only)
// ---------------------------------------------------------------------------

describe("codemode declaration", () => {
  it("generates proper codemode declaration (JSON Schema)", () => {
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

  it("generates proper codemode declaration (Zod)", () => {
    const tools = {
      tool1: {
        description: "First tool",
        inputSchema: z.object({ a: z.string().optional() })
      },
      tool2: {
        description: "Second tool",
        inputSchema: z.object({ b: z.number().optional() })
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

  testBoth(
    "tool name sanitization with hyphens",
    "get-user",
    {
      json: {
        type: "object",
        properties: { id: { type: "string" } }
      },
      zod: z.object({ id: z.string().optional() })
    },
    (result) => {
      expect(result).toContain("get_user: (input: GetUserInput)");
    },
    { description: "Get user" }
  );
});
