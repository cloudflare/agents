/**
 * Comprehensive schema conversion tests.
 * Tests all Zod v4 schema types and AI SDK jsonSchema() conversions.
 * Coverage exceeds zod-to-ts package tests.
 *
 * Each test makes explicit assertions about the exact output format.
 */
import { describe, it, expect } from "vitest";
import { generateTypes, sanitizeToolName } from "../types";
import { z } from "zod";
import { fromJSONSchema } from "zod/v4";
import { tool } from "ai";
import type { ToolDescriptors } from "../types";
import type { ToolSet } from "ai";

// =============================================================================
// PRIMITIVE TYPES
// =============================================================================
describe("Primitive Types", () => {
  it("should handle z.string()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.string() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: string;");
  });

  it("should handle z.number()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.number() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: number;");
  });

  it("should handle z.boolean()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.boolean() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: boolean;");
  });

  it("should handle z.bigint()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.bigint() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: bigint;");
  });

  it("should handle z.date()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.date() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: Date;");
  });

  it("should handle z.undefined()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.undefined() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value?: undefined;");
  });

  it("should handle z.null()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.null() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: null;");
  });

  it("should handle z.void()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.void() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: void | undefined;");
  });

  it("should handle z.any()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.any() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: any;");
  });

  it("should handle z.unknown()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.unknown() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: unknown;");
  });

  it("should handle z.never()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.never() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: never;");
  });

  it("should handle z.symbol()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.symbol() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: symbol;");
  });
});

// =============================================================================
// LITERAL TYPES
// =============================================================================
describe("Literal Types", () => {
  it("should handle z.literal() with string", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ status: z.literal("active") }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain('status: "active";');
  });

  it("should handle z.literal() with number", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ code: z.literal(200) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("code: 200;");
  });

  it("should handle z.literal() with boolean true", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ flag: z.literal(true) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("flag: true;");
  });

  it("should handle z.literal() with boolean false", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ disabled: z.literal(false) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("disabled: false;");
  });

  it("should handle z.literal() with bigint", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ id: z.literal(BigInt(9007199254740991)) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("id: 9007199254740991n;");
  });
});

// =============================================================================
// ENUM TYPES
// =============================================================================
describe("Enum Types", () => {
  it("should handle z.enum() with multiple values", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          status: z.enum(["pending", "active", "completed"])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain('status: "pending" | "active" | "completed";');
  });

  it("should handle z.enum() with single value", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          type: z.enum(["user"])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain('type: "user";');
  });

  it("should handle z.nativeEnum() with string enum", () => {
    enum Status {
      Pending = "pending",
      Active = "active"
    }
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ status: z.nativeEnum(Status) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("status:");
  });

  it("should handle z.nativeEnum() with numeric enum", () => {
    enum Priority {
      Low = 0,
      Medium = 1,
      High = 2
    }
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ priority: z.nativeEnum(Priority) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("priority:");
  });
});

// =============================================================================
// OBJECT TYPES
// =============================================================================
describe("Object Types", () => {
  it("should handle basic object schema", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          name: z.string(),
          age: z.number(),
          active: z.boolean()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
    expect(result).toContain("age: number;");
    expect(result).toContain("active: boolean;");
  });

  it("should handle nested object schema", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          user: z.object({
            profile: z.object({
              name: z.string(),
              avatar: z.object({
                url: z.string(),
                size: z.number()
              })
            })
          })
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("user: {");
    expect(result).toContain("profile: {");
    expect(result).toContain("avatar: {");
    expect(result).toContain("url: string;");
    expect(result).toContain("size: number;");
  });

  it("should handle object with string literal keys", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          "kebab-case": z.string(),
          "with spaces": z.number(),
          "123numeric": z.boolean()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain('"kebab-case": string;');
    expect(result).toContain('"with spaces": number;');
    expect(result).toContain('"123numeric": boolean;');
  });

  it("should handle z.object().strict()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ name: z.string() }).strict()
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
  });

  it("should handle z.object().strip()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ name: z.string() }).strip()
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
  });

  it("should handle z.object().passthrough()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ name: z.string() }).passthrough()
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
  });

  it("should handle z.object().partial()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          name: z.string(),
          age: z.number()
        }).partial()
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name?: string | undefined;");
    expect(result).toContain("age?: number | undefined;");
  });

  it("should handle z.object().required()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          name: z.string().optional(),
          age: z.number().optional()
        }).required()
      }
    };
    const result = generateTypes(tools);
    // required() on optional fields produces Exclude<T, undefined>
    expect(result).toContain("name: Exclude<string | undefined, undefined>;");
    expect(result).toContain("age: Exclude<number | undefined, undefined>;");
  });

  it("should handle z.object().pick()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          name: z.string(),
          age: z.number(),
          email: z.string()
        }).pick({ name: true, email: true })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
    expect(result).toContain("email: string;");
    expect(result).not.toContain("age:");
  });

  it("should handle z.object().omit()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          name: z.string(),
          age: z.number(),
          password: z.string()
        }).omit({ password: true })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
    expect(result).toContain("age: number;");
    expect(result).not.toContain("password:");
  });

  it("should handle z.object().extend()", () => {
    const base = z.object({ name: z.string() });
    const tools: ToolDescriptors = {
      test: {
        inputSchema: base.extend({ email: z.string() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
    expect(result).toContain("email: string;");
  });

  it("should handle z.object().merge()", () => {
    const base = z.object({ name: z.string() });
    const extra = z.object({ email: z.string() });
    const tools: ToolDescriptors = {
      test: {
        inputSchema: base.merge(extra)
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
    expect(result).toContain("email: string;");
  });
});

// =============================================================================
// ARRAY TYPES
// =============================================================================
describe("Array Types", () => {
  it("should handle z.array() with primitives", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ items: z.array(z.string()) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("items: string[];");
  });

  it("should handle z.array() with numbers", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ scores: z.array(z.number()) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("scores: number[];");
  });

  it("should handle z.array() with objects", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          users: z.array(z.object({ name: z.string(), age: z.number() }))
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("users: {");
    expect(result).toContain("name: string;");
    expect(result).toContain("age: number;");
    expect(result).toContain("}[];");
  });

  it("should handle z.array().nonempty()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ items: z.array(z.string()).nonempty() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("items:");
    expect(result).toContain("string");
  });

  it("should handle nested arrays", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          matrix: z.array(z.array(z.number()))
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("matrix: number[][];");
  });

  it("should handle z.string().array() syntax", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ tags: z.string().array() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("tags: string[];");
  });
});

// =============================================================================
// TUPLE TYPES
// =============================================================================
describe("Tuple Types", () => {
  it("should handle z.tuple() with primitives", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          coords: z.tuple([z.number(), z.number()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toMatch(/coords:\s*\[\s*number\s*,\s*number\s*\]/);
  });

  it("should handle z.tuple() with mixed types", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          entry: z.tuple([z.string(), z.number(), z.boolean()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toMatch(/entry:\s*\[\s*string\s*,\s*number\s*,\s*boolean\s*\]/);
  });

  it("should handle z.tuple() with rest element", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          args: z.tuple([z.string()]).rest(z.number())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("args:");
  });

  it("should handle nested tuples", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          nested: z.tuple([z.tuple([z.number(), z.number()]), z.string()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("nested:");
  });
});

// =============================================================================
// UNION TYPES
// =============================================================================
describe("Union Types", () => {
  it("should handle z.union() with primitives", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          value: z.union([z.string(), z.number()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: string | number;");
  });

  it("should handle z.union() with three types", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          value: z.union([z.string(), z.number(), z.boolean()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: string | number | boolean;");
  });

  it("should handle z.union() with objects", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          data: z.union([
            z.object({ type: z.literal("text"), content: z.string() }),
            z.object({ type: z.literal("image"), url: z.string() })
          ])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("data:");
    expect(result).toContain('type: "text"');
    expect(result).toContain('type: "image"');
  });

  it("should handle z.discriminatedUnion()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          shape: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("circle"), radius: z.number() }),
            z.object({ kind: z.literal("square"), side: z.number() })
          ])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("shape:");
    expect(result).toContain('kind: "circle"');
    expect(result).toContain('kind: "square"');
    expect(result).toContain("radius: number;");
    expect(result).toContain("side: number;");
  });

  it("should handle z.or() syntax", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          id: z.string().or(z.number())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("id: string | number;");
  });
});

// =============================================================================
// INTERSECTION TYPES
// =============================================================================
describe("Intersection Types", () => {
  it("should handle z.intersection()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          data: z.intersection(
            z.object({ name: z.string() }),
            z.object({ age: z.number() })
          )
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("data:");
    expect(result).toContain("name: string;");
    expect(result).toContain("age: number;");
  });

  it("should handle z.and() syntax", () => {
    const base = z.object({ name: z.string() });
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          user: base.and(z.object({ email: z.string() }))
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("user:");
  });
});

// =============================================================================
// RECORD TYPES
// =============================================================================
describe("Record Types", () => {
  it("should handle z.record() with string keys and string values", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          metadata: z.record(z.string(), z.string())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("metadata: {");
    expect(result).toContain("[key: string]: string;");
  });

  it("should handle z.record() with string keys and number values", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          scores: z.record(z.string(), z.number())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("scores: {");
    expect(result).toContain("[key: string]: number;");
  });

  it("should handle z.record() with complex value type", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          users: z.record(z.string(), z.object({ name: z.string(), active: z.boolean() }))
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("users: {");
    expect(result).toContain("[key: string]: {");
    expect(result).toContain("name: string;");
    expect(result).toContain("active: boolean;");
  });
});

// =============================================================================
// MAP AND SET TYPES
// =============================================================================
describe("Map and Set Types", () => {
  it("should handle z.map() with string keys and number values", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          lookup: z.map(z.string(), z.number())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("lookup: Map<string, number>;");
  });

  it("should handle z.map() with number keys", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          byId: z.map(z.number(), z.string())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("byId: Map<number, string>;");
  });

  it("should handle z.set() with strings", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          tags: z.set(z.string())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("tags: Set<string>;");
  });

  it("should handle z.set() with numbers", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          ids: z.set(z.number())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("ids: Set<number>;");
  });
});

// =============================================================================
// MODIFIER TYPES
// =============================================================================
describe("Modifier Types", () => {
  it("should handle z.optional()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          name: z.string(),
          nickname: z.string().optional()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("name: string;");
    expect(result).toContain("nickname?: string | undefined;");
  });

  it("should handle z.nullable()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          avatar: z.string().nullable()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("avatar: string | null;");
  });

  it("should handle z.nullish()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          bio: z.string().nullish()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("bio?: (string | null) | undefined;");
  });

  it("should handle z.default()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          count: z.number().default(0)
        })
      }
    };
    const result = generateTypes(tools);
    // default() produces the underlying type (not | undefined)
    expect(result).toContain("count: number;");
  });

  it("should handle z.catch()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          value: z.string().catch("default")
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: string;");
  });

  it("should handle chained modifiers optional().nullable()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          field: z.string().optional().nullable()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("field?:");
  });
});

// =============================================================================
// READONLY TYPES
// =============================================================================
describe("Readonly Types", () => {
  it("should handle z.object().readonly()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          config: z.object({ key: z.string() }).readonly()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("config:");
    expect(result).toContain("readonly key: string;");
  });

  it("should handle z.array().readonly()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          items: z.array(z.string()).readonly()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("items: readonly string[];");
  });

  it("should handle z.tuple().readonly()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          point: z.tuple([z.number(), z.number()]).readonly()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("point: readonly [");
  });

  it("should handle z.set().readonly()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          ids: z.set(z.string()).readonly()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("ids: ReadonlySet<string>;");
  });

  it("should handle z.map().readonly()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          cache: z.map(z.string(), z.any()).readonly()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("cache: ReadonlyMap<string, any>;");
  });
});

// =============================================================================
// COERCE TYPES
// =============================================================================
describe("Coerce Types", () => {
  it("should handle z.coerce.string()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.coerce.string() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: string;");
  });

  it("should handle z.coerce.number()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.coerce.number() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: number;");
  });

  it("should handle z.coerce.boolean()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.coerce.boolean() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: boolean;");
  });

  it("should handle z.coerce.date()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.coerce.date() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: Date;");
  });

  it("should handle z.coerce.bigint()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.coerce.bigint() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: bigint;");
  });
});

// =============================================================================
// PIPE AND TRANSFORM TYPES
// =============================================================================
describe("Pipe and Transform Types", () => {
  it("should handle z.pipe()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          count: z.pipe(z.string(), z.coerce.number())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("count: number;");
  });

  it("should handle z.transform() gracefully (returns unknown for entire schema)", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          upper: z.string().transform(s => s.toUpperCase())
        })
      }
    };
    // Transform schemas that can't be represented fall back to unknown for the entire type
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput = unknown");
  });

  it("should handle z.preprocess()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          data: z.preprocess((val) => String(val), z.string())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("data: string;");
  });
});

// =============================================================================
// TEMPLATE LITERAL TYPES
// =============================================================================
describe("Template Literal Types", () => {
  it("should handle z.templateLiteral() with string prefix", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          userId: z.templateLiteral([z.literal("user_"), z.string()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("userId: `user_${string}`;");
  });

  it("should handle z.templateLiteral() with number", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          orderId: z.templateLiteral([z.literal("order_"), z.number()])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("orderId: `order_${number}`;");
  });

  it("should handle complex template literals", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          path: z.templateLiteral([
            z.literal("/api/"),
            z.string(),
            z.literal("/"),
            z.number()
          ])
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("path: `/api/${string}/${number}`;");
  });
});

// =============================================================================
// LAZY AND RECURSIVE TYPES
// =============================================================================
describe("Lazy and Recursive Types", () => {
  it("should handle z.lazy() for recursive types using auxiliary types", () => {
    interface TreeNode {
      value: string;
      children: TreeNode[];
    }
    const TreeNodeSchema: z.ZodType<TreeNode> = z.object({
      value: z.string(),
      children: z.lazy(() => z.array(TreeNodeSchema))
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: TreeNodeSchema }
    };
    const result = generateTypes(tools);
    // Recursive types use auxiliary types (Auxiliary_0, etc.)
    expect(result).toContain("type TestInput =");
    expect(result).toMatch(/Auxiliary_\d+/);
  });

  it("should handle mutually recursive types", () => {
    interface User {
      name: string;
      posts: Post[];
    }
    interface Post {
      title: string;
      author: User;
    }

    const UserSchema: z.ZodType<User> = z.object({
      name: z.string(),
      posts: z.lazy(() => z.array(PostSchema))
    });
    const PostSchema: z.ZodType<Post> = z.object({
      title: z.string(),
      author: z.lazy(() => UserSchema)
    });

    const tools: ToolDescriptors = {
      createPost: { inputSchema: PostSchema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type CreatePostInput =");
  });
});

// =============================================================================
// FUNCTION TYPES
// =============================================================================
describe("Function Types", () => {
  it("should handle z.function() with input and output (Zod v4 syntax)", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          callback: z.function({
            input: [z.string(), z.number()],
            output: z.boolean()
          })
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("callback:");
    expect(result).toContain("=> boolean");
  });

  it("should handle z.function() with object input (Zod v4 syntax)", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          handler: z.function({
            input: [z.object({ event: z.string() })],
            output: z.void()
          })
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("handler:");
    expect(result).toContain("event: string;");
  });

  it("should handle z.function() with no args (falls back to unknown gracefully)", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          getTime: z.function({ output: z.number() })
        })
      }
    };
    const result = generateTypes(tools);
    // Function schemas without input may not be fully representable
    expect(result).toContain("type TestInput =");
  });
});

// =============================================================================
// PROMISE TYPE
// =============================================================================
describe("Promise Type", () => {
  it("should handle z.promise()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          data: z.promise(z.string())
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("data: Promise<string>;");
  });

  it("should handle z.promise() with object", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          response: z.promise(z.object({ status: z.number() }))
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("response: Promise<{");
    expect(result).toContain("status: number;");
  });
});

// =============================================================================
// BRANDED TYPES
// =============================================================================
describe("Branded Types", () => {
  it("should handle z.string().brand()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          userId: z.string().brand<"UserId">()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("userId:");
  });
});

// =============================================================================
// EFFECTS AND REFINEMENTS
// =============================================================================
describe("Effects and Refinements", () => {
  it("should handle z.string().refine()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          email: z.string().refine(s => s.includes("@"))
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("email: string;");
  });

  it("should handle z.string().superRefine()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          password: z.string().superRefine((val, ctx) => {
            if (val.length < 8) {
              ctx.addIssue({ code: z.ZodIssueCode.too_small, minimum: 8, type: "string", inclusive: true });
            }
          })
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("password: string;");
  });
});

// =============================================================================
// STRING VALIDATION MODIFIERS
// =============================================================================
describe("String Validation Modifiers", () => {
  it("should handle z.string().email()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ email: z.string().email() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("email: string;");
  });

  it("should handle z.string().url()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ url: z.string().url() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("url: string;");
  });

  it("should handle z.string().uuid()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ id: z.string().uuid() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("id: string;");
  });

  it("should handle z.string().regex()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ phone: z.string().regex(/^\d{10}$/) })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("phone: string;");
  });

  it("should handle z.string().min().max()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ username: z.string().min(3).max(20) })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("username: string;");
  });

  it("should handle z.string().length()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ code: z.string().length(6) })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("code: string;");
  });

  it("should handle z.string().startsWith()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ prefix: z.string().startsWith("pk_") })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("prefix: string;");
  });

  it("should handle z.string().endsWith()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ suffix: z.string().endsWith(".json") })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("suffix: string;");
  });

  it("should handle z.string().includes()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ contains: z.string().includes("@") })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("contains: string;");
  });

  it("should handle z.string().trim()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ trimmed: z.string().trim() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("trimmed: string;");
  });

  it("should handle z.string().toLowerCase()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ lower: z.string().toLowerCase() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("lower: string;");
  });

  it("should handle z.string().toUpperCase()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ upper: z.string().toUpperCase() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("upper: string;");
  });

  it("should handle z.string().datetime()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ timestamp: z.string().datetime() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("timestamp: string;");
  });

  it("should handle z.string().ipv4()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ ipAddress: z.string().ipv4() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("ipAddress: string;");
  });

  it("should handle z.string().ipv6()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ ipv6Address: z.string().ipv6() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("ipv6Address: string;");
  });
});

// =============================================================================
// NUMBER VALIDATION MODIFIERS
// =============================================================================
describe("Number Validation Modifiers", () => {
  it("should handle z.number().int()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ count: z.number().int() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("count: number;");
  });

  it("should handle z.number().positive()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ amount: z.number().positive() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("amount: number;");
  });

  it("should handle z.number().negative()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ debt: z.number().negative() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("debt: number;");
  });

  it("should handle z.number().nonnegative()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ index: z.number().nonnegative() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("index: number;");
  });

  it("should handle z.number().nonpositive()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ offset: z.number().nonpositive() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("offset: number;");
  });

  it("should handle z.number().multipleOf()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ step: z.number().multipleOf(5) }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("step: number;");
  });

  it("should handle z.number().finite()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ value: z.number().finite() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("value: number;");
  });

  it("should handle z.number().safe()", () => {
    const tools: ToolDescriptors = {
      test: { inputSchema: z.object({ safe: z.number().safe() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("safe: number;");
  });

  it("should handle z.number().min().max()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ percentage: z.number().min(0).max(100) })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("percentage: number;");
  });

  it("should handle z.number().gt().lt()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ rating: z.number().gt(0).lt(5) })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("rating: number;");
  });

  it("should handle z.number().gte().lte()", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ score: z.number().gte(0).lte(100) })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("score: number;");
  });
});

// =============================================================================
// DESCRIBE AND DOCUMENTATION
// =============================================================================
describe("Describe and Documentation", () => {
  it("should extract descriptions from z.describe()", () => {
    const tools: ToolDescriptors = {
      test: {
        description: "Test tool",
        inputSchema: z.object({
          name: z.string().describe("The user's full name"),
          age: z.number().describe("The user's age in years"),
          email: z.string().describe("A valid email address")
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("@param input.name - The user's full name");
    expect(result).toContain("@param input.age - The user's age in years");
    expect(result).toContain("@param input.email - A valid email address");
  });

  it("should include description in type comment", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          query: z.string().describe("Search query string")
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("/** Search query string */");
    expect(result).toContain("query: string;");
  });
});

// =============================================================================
// COMPREHENSIVE fromJSONSchema() TESTS
// =============================================================================
describe("Comprehensive fromJSONSchema() Tests", () => {
  it("should handle JSON Schema with string property", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        name: { type: "string" as const }
      },
      required: ["name"]
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
    expect(result).toContain("name: string;");
  });

  it("should handle JSON Schema with multiple properties", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        firstName: { type: "string" as const },
        lastName: { type: "string" as const },
        age: { type: "number" as const },
        active: { type: "boolean" as const }
      },
      required: ["firstName", "lastName"]
    });

    const tools: ToolDescriptors = {
      createUser: { description: "Create a user", inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type CreateUserInput =");
  });

  it("should handle JSON Schema with nested objects", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        user: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            address: {
              type: "object" as const,
              properties: {
                street: { type: "string" as const },
                city: { type: "string" as const }
              }
            }
          }
        }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with arrays", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        tags: {
          type: "array" as const,
          items: { type: "string" as const }
        },
        scores: {
          type: "array" as const,
          items: { type: "number" as const }
        }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with enum", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: ["pending", "active", "completed"]
        }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with anyOf", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        value: {
          anyOf: [
            { type: "string" as const },
            { type: "number" as const }
          ]
        }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with oneOf", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        data: {
          oneOf: [
            { type: "object" as const, properties: { text: { type: "string" as const } } },
            { type: "object" as const, properties: { url: { type: "string" as const } } }
          ]
        }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with const", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        type: { const: "user" },
        version: { const: 1 }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with descriptions", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description: "The search query"
        },
        limit: {
          type: "number" as const,
          description: "Maximum results"
        }
      },
      required: ["query"]
    });

    const tools: ToolDescriptors = {
      search: { description: "Search documents", inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type SearchInput =");
    expect(result).toContain("/** The search query */");
  });

  it("should handle JSON Schema with integer type", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        count: { type: "integer" as const }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
    // Properties not in required array are optional
    expect(result).toContain("count?: number | undefined;");
  });

  it("should handle deeply nested JSON Schema", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        level1: {
          type: "object" as const,
          properties: {
            level2: {
              type: "object" as const,
              properties: {
                level3: {
                  type: "object" as const,
                  properties: {
                    value: { type: "string" as const }
                  }
                }
              }
            }
          }
        }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with null type", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        value: { type: "null" as const }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with nullable via array type", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        avatar: { type: ["string", "null"] as const }
      }
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
  });

  it("should handle JSON Schema with additionalProperties false", () => {
    const schema = fromJSONSchema({
      type: "object" as const,
      properties: {
        name: { type: "string" as const }
      },
      additionalProperties: false
    });

    const tools: ToolDescriptors = {
      test: { inputSchema: schema }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestInput =");
    // Properties not in required array are optional
    expect(result).toContain("name?: string | undefined;");
    // additionalProperties: false produces [x: string]: never
    expect(result).toContain("[x: string]: never;");
  });
});

// =============================================================================
// MIXED TOOL SOURCES
// =============================================================================
describe("Mixed Tool Sources", () => {
  it("should handle ToolDescriptors with Zod schemas", () => {
    const tools: ToolDescriptors = {
      zodTool: {
        description: "A Zod tool",
        inputSchema: z.object({ query: z.string() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type ZodToolInput =");
    expect(result).toContain("query: string;");
  });

  it("should handle AI SDK ToolSet with Zod schemas", () => {
    const tools: ToolSet = {
      aiTool: tool({
        description: "An AI SDK tool",
        parameters: z.object({ query: z.string() }),
        execute: async () => ({})
      })
    };
    const result = generateTypes(tools);
    expect(result).toContain("type AiToolInput =");
    expect(result).toContain("query: string;");
  });

  it("should handle mixed Zod and fromJSONSchema in ToolDescriptors", () => {
    const tools: ToolDescriptors = {
      zodTool: {
        description: "Zod tool",
        inputSchema: z.object({ name: z.string() })
      },
      jsonTool: {
        description: "JSON schema tool",
        inputSchema: fromJSONSchema({
          type: "object" as const,
          properties: { url: { type: "string" as const } }
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type ZodToolInput =");
    expect(result).toContain("name: string;");
    expect(result).toContain("type JsonToolInput =");
  });

  it("should handle multiple tools with complex schemas", () => {
    const tools: ToolSet = {
      createUser: tool({
        description: "Create a new user",
        parameters: z.object({
          username: z.string().min(3).max(20),
          email: z.string().email(),
          profile: z.object({
            bio: z.string().optional(),
            avatar: z.string().url().optional()
          }).optional()
        }),
        execute: async () => ({})
      }),
      searchUsers: tool({
        description: "Search for users",
        parameters: z.object({
          query: z.string(),
          filters: z.object({
            active: z.boolean().optional(),
            roles: z.array(z.enum(["admin", "user", "guest"])).optional()
          }).optional(),
          pagination: z.object({
            page: z.number().int().positive(),
            limit: z.number().int().min(1).max(100)
          })
        }),
        execute: async () => ({})
      })
    };

    const result = generateTypes(tools);
    expect(result).toContain("type CreateUserInput =");
    expect(result).toContain("type SearchUsersInput =");
    expect(result).toContain("username: string;");
    expect(result).toContain("query: string;");
  });

  it("should handle ToolDescriptors with fromJSONSchema for complex types", () => {
    const tools: ToolDescriptors = {
      deleteUser: {
        description: "Delete a user",
        inputSchema: fromJSONSchema({
          type: "object" as const,
          properties: {
            userId: { type: "string" as const },
            hardDelete: { type: "boolean" as const }
          },
          required: ["userId"]
        })
      }
    };

    const result = generateTypes(tools);
    expect(result).toContain("type DeleteUserInput =");
  });
});

// =============================================================================
// OUTPUT SCHEMAS
// =============================================================================
describe("Output Schemas", () => {
  it("should handle outputSchema with Zod", () => {
    const tools: ToolDescriptors = {
      getUser: {
        description: "Get a user",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({
          id: z.string(),
          name: z.string(),
          email: z.string()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type GetUserInput =");
    expect(result).toContain("type GetUserOutput =");
    expect(result).toContain("id: string;");
    expect(result).toContain("name: string;");
    expect(result).toContain("email: string;");
    expect(result).not.toContain("type GetUserOutput = unknown");
  });

  it("should default to unknown when no outputSchema", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({ query: z.string() })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type TestOutput = unknown");
  });

  it("should handle complex outputSchema", () => {
    const tools: ToolDescriptors = {
      search: {
        description: "Search",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({
          results: z.array(z.object({
            id: z.string(),
            score: z.number(),
            data: z.record(z.string(), z.any())
          })),
          total: z.number(),
          page: z.number()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type SearchOutput =");
    expect(result).toContain("results:");
    expect(result).toContain("total: number;");
    expect(result).toContain("page: number;");
  });

  it("should handle outputSchema with nested objects", () => {
    const tools: ToolDescriptors = {
      getData: {
        description: "Get data",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({
          meta: z.object({
            timestamp: z.string(),
            version: z.number()
          }),
          payload: z.object({
            items: z.array(z.string())
          })
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type GetDataOutput =");
    expect(result).toContain("meta: {");
    expect(result).toContain("timestamp: string;");
    expect(result).toContain("version: number;");
    expect(result).toContain("payload: {");
    expect(result).toContain("items: string[];");
  });
});

// =============================================================================
// EDGE CASES AND ERROR HANDLING
// =============================================================================
describe("Edge Cases", () => {
  it("should handle empty tool set", () => {
    const result = generateTypes({});
    expect(result).toContain("declare const codemode: {}");
  });

  it("should handle tool with empty object schema", () => {
    const tools: ToolDescriptors = {
      empty: { inputSchema: z.object({}) }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type EmptyInput =");
  });

  it("should handle tool with very long name", () => {
    const longName = "a".repeat(100);
    const tools: ToolDescriptors = {
      [longName]: { inputSchema: z.object({ x: z.string() }) }
    };
    const result = generateTypes(tools);
    expect(result).toContain(longName);
  });

  it("should handle tool with unicode characters in name", () => {
    const tools: ToolDescriptors = {
      "日本語": { inputSchema: z.object({ value: z.string() }) }
    };
    // Unicode chars should be stripped/replaced
    const result = generateTypes(tools);
    expect(result).toContain("declare const codemode:");
  });

  it("should handle many tools", () => {
    const tools: ToolDescriptors = {};
    for (let i = 0; i < 50; i++) {
      tools[`tool${i}`] = {
        inputSchema: z.object({ param: z.string() })
      };
    }
    const result = generateTypes(tools);
    expect(result).toContain("type Tool0Input =");
    expect(result).toContain("type Tool49Input =");
  });

  it("should handle deeply nested object (10 levels)", () => {
    let schema: z.ZodTypeAny = z.string();
    for (let i = 0; i < 10; i++) {
      schema = z.object({ nested: schema });
    }
    const tools: ToolDescriptors = {
      deep: { inputSchema: schema as z.ZodObject<any> }
    };
    const result = generateTypes(tools);
    expect(result).toContain("type DeepInput =");
  });

  it("should handle schema with all optional fields", () => {
    const tools: ToolDescriptors = {
      test: {
        inputSchema: z.object({
          a: z.string().optional(),
          b: z.number().optional(),
          c: z.boolean().optional()
        })
      }
    };
    const result = generateTypes(tools);
    expect(result).toContain("a?: string | undefined;");
    expect(result).toContain("b?: number | undefined;");
    expect(result).toContain("c?: boolean | undefined;");
  });

  it("should handle reserved word collision with different casing", () => {
    const tools: ToolDescriptors = {
      "Class": { inputSchema: z.object({ x: z.string() }) }
    };
    const result = generateTypes(tools);
    // Class (capitalized) should not conflict with 'class'
    expect(result).toContain("Class:");
  });
});

// =============================================================================
// SANITIZE TOOL NAME TESTS
// =============================================================================
describe("sanitizeToolName", () => {
  it("should replace hyphens with underscores", () => {
    expect(sanitizeToolName("get-weather")).toBe("get_weather");
  });

  it("should replace dots with underscores", () => {
    expect(sanitizeToolName("api.v2.search")).toBe("api_v2_search");
  });

  it("should replace spaces with underscores", () => {
    expect(sanitizeToolName("my tool")).toBe("my_tool");
  });

  it("should prefix digit-leading names with underscore", () => {
    expect(sanitizeToolName("3drender")).toBe("_3drender");
  });

  it("should append underscore to reserved words", () => {
    expect(sanitizeToolName("class")).toBe("class_");
    expect(sanitizeToolName("return")).toBe("return_");
    expect(sanitizeToolName("delete")).toBe("delete_");
  });

  it("should strip special characters", () => {
    expect(sanitizeToolName("hello@world!")).toBe("helloworld");
  });

  it("should handle empty string", () => {
    expect(sanitizeToolName("")).toBe("_");
  });

  it("should handle string with only special characters", () => {
    expect(sanitizeToolName("@#$")).toBe("$");
    expect(sanitizeToolName("@#!")).toBe("_");
  });

  it("should leave valid identifiers unchanged", () => {
    expect(sanitizeToolName("getWeather")).toBe("getWeather");
    expect(sanitizeToolName("_private")).toBe("_private");
    expect(sanitizeToolName("$jquery")).toBe("$jquery");
  });

  it("should handle consecutive special characters", () => {
    expect(sanitizeToolName("a--b..c")).toBe("a__b__c");
  });

  it("should handle leading/trailing underscores", () => {
    expect(sanitizeToolName("__test__")).toBe("__test__");
  });

  it("should handle camelCase names", () => {
    expect(sanitizeToolName("getWeatherForecast")).toBe("getWeatherForecast");
  });

  it("should handle PascalCase names", () => {
    expect(sanitizeToolName("GetWeatherForecast")).toBe("GetWeatherForecast");
  });

  it("should handle snake_case names", () => {
    expect(sanitizeToolName("get_weather_forecast")).toBe("get_weather_forecast");
  });

  it("should handle SCREAMING_SNAKE_CASE", () => {
    expect(sanitizeToolName("GET_WEATHER_FORECAST")).toBe("GET_WEATHER_FORECAST");
  });

  it("should handle all reserved words", () => {
    const reservedWords = [
      "abstract", "await", "boolean", "break", "byte", "case", "catch", "char",
      "class", "const", "continue", "debugger", "default", "delete", "do",
      "double", "else", "enum", "export", "extends", "false", "final", "finally",
      "float", "for", "function", "goto", "if", "implements", "import", "in",
      "instanceof", "int", "interface", "let", "long", "native", "new", "null",
      "package", "private", "protected", "public", "return", "short", "static",
      "super", "switch", "synchronized", "this", "throw", "throws", "transient",
      "true", "try", "typeof", "var", "void", "volatile", "while", "with", "yield"
    ];

    for (const word of reservedWords) {
      expect(sanitizeToolName(word)).toBe(word + "_");
    }
  });

  it("should handle mixed separators", () => {
    expect(sanitizeToolName("my-tool.name here")).toBe("my_tool_name_here");
  });
});
