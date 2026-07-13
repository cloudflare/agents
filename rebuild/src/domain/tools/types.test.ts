import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool, toDescriptor, type Tool, type ToolExecutionContext } from "./types.js";

describe("tool()", () => {
  it("is an identity helper that returns the definition unchanged", () => {
    const def: Tool<{ x: number }, number> = {
      description: "doubles a number",
      inputSchema: z.object({ x: z.number() }),
      execute: (input) => input.x * 2,
    };
    const t = tool(def);
    expect(t).toBe(def);
  });

  it("accepts a tool with no execute (client tool)", () => {
    const t = tool({ description: "client-only", inputSchema: z.object({}) });
    expect(t.execute).toBeUndefined();
  });
});

describe("toDescriptor", () => {
  it("carries name and description through unchanged", () => {
    const t = tool({ description: "does a thing", inputSchema: z.object({}) });
    const d = toDescriptor("my_tool", t);
    expect(d.name).toBe("my_tool");
    expect(d.description).toBe("does a thing");
  });

  it("accepts the { jsonSchema } passthrough form", () => {
    const raw = { type: "object", properties: { a: { type: "string" } } };
    const t = tool({ description: "passthrough", inputSchema: { jsonSchema: raw } });
    const d = toDescriptor("raw_tool", t);
    expect(d.inputSchema).toBe(raw);
  });

  describe("zod -> JSON schema conversion", () => {
    it("converts z.object with required and optional props", () => {
      const t = tool({
        description: "",
        inputSchema: z.object({
          name: z.string(),
          nickname: z.string().optional(),
        }),
      });
      const d = toDescriptor("t", t);
      expect(d.inputSchema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          nickname: { type: "string" },
        },
        required: ["name"],
      });
    });

    it("omits the required array when every property is optional", () => {
      const t = tool({ description: "", inputSchema: z.object({ a: z.string().optional() }) });
      const d = toDescriptor("t", t);
      expect(d.inputSchema).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
      });
    });

    it("converts z.string to { type: 'string' }", () => {
      const t = tool({ description: "", inputSchema: z.object({ s: z.string() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { s: unknown } } };
      expect(d.inputSchema.properties.s).toEqual({ type: "string" });
    });

    it("converts z.enum to a string enum", () => {
      const t = tool({ description: "", inputSchema: z.object({ color: z.enum(["red", "green", "blue"]) }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { color: unknown } } };
      expect(d.inputSchema.properties.color).toEqual({ type: "string", enum: ["red", "green", "blue"] });
    });

    it("converts z.number to { type: 'number' }", () => {
      const t = tool({ description: "", inputSchema: z.object({ n: z.number() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { n: unknown } } };
      expect(d.inputSchema.properties.n).toEqual({ type: "number" });
    });

    it("converts z.number().int() to { type: 'integer' }", () => {
      const t = tool({ description: "", inputSchema: z.object({ n: z.number().int() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { n: unknown } } };
      expect(d.inputSchema.properties.n).toEqual({ type: "integer" });
    });

    it("converts z.boolean to { type: 'boolean' }", () => {
      const t = tool({ description: "", inputSchema: z.object({ b: z.boolean() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { b: unknown } } };
      expect(d.inputSchema.properties.b).toEqual({ type: "boolean" });
    });

    it("converts z.array to { type: 'array', items }", () => {
      const t = tool({ description: "", inputSchema: z.object({ tags: z.array(z.string()) }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { tags: unknown } } };
      expect(d.inputSchema.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    });

    it("converts z.record to { type: 'object', additionalProperties }", () => {
      const t = tool({ description: "", inputSchema: z.object({ meta: z.record(z.number()) }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { meta: unknown } } };
      expect(d.inputSchema.properties.meta).toEqual({ type: "object", additionalProperties: { type: "number" } });
    });

    it("converts a union of literals to an enum", () => {
      const t = tool({
        description: "",
        inputSchema: z.object({ mode: z.union([z.literal("fast"), z.literal("slow")]) }),
      });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { mode: unknown } } };
      expect(d.inputSchema.properties.mode).toEqual({ type: "string", enum: ["fast", "slow"] });
    });

    it("unwraps z.optional to the inner schema (property-level optionality handled separately)", () => {
      const t = tool({ description: "", inputSchema: z.object({ a: z.string().optional() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { a: unknown } } };
      expect(d.inputSchema.properties.a).toEqual({ type: "string" });
    });

    it("converts z.default to the inner schema plus a default keyword, and excludes it from required", () => {
      const t = tool({ description: "", inputSchema: z.object({ count: z.number().default(0) }) });
      const d = toDescriptor("t", t) as {
        inputSchema: { properties: { count: unknown }; required?: string[] };
      };
      expect(d.inputSchema.properties.count).toEqual({ type: "number", default: 0 });
      expect(d.inputSchema.required).toBeUndefined();
    });

    it("converts z.nullable to a type union including null", () => {
      const t = tool({ description: "", inputSchema: z.object({ a: z.string().nullable() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { a: unknown } } };
      expect(d.inputSchema.properties.a).toEqual({ type: ["string", "null"] });
    });

    it("carries .describe() descriptions through onto the schema node", () => {
      const t = tool({
        description: "",
        inputSchema: z.object({ q: z.string().describe("the search query") }),
      });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { q: unknown } } };
      expect(d.inputSchema.properties.q).toEqual({ type: "string", description: "the search query" });
    });

    it("falls back to a permissive {} schema for unsupported zod types", () => {
      const t = tool({ description: "", inputSchema: z.object({ any: z.any(), fn: z.function() }) });
      const d = toDescriptor("t", t) as { inputSchema: { properties: { any: unknown; fn: unknown } } };
      expect(d.inputSchema.properties.any).toEqual({});
      expect(d.inputSchema.properties.fn).toEqual({});
    });

    it("handles nested objects and arrays of objects", () => {
      const t = tool({
        description: "",
        inputSchema: z.object({
          items: z.array(z.object({ id: z.string(), qty: z.number().int().optional() })),
        }),
      });
      const d = toDescriptor("t", t);
      expect(d.inputSchema).toEqual({
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, qty: { type: "integer" } },
              required: ["id"],
            },
          },
        },
        required: ["items"],
      });
    });
  });
});

describe("ToolExecutionContext", () => {
  it("is a plain shape usable by execute()", async () => {
    const ctx: ToolExecutionContext = {
      toolCallId: "call_1",
      requestId: "req_1",
      messages: [],
      signal: new AbortController().signal,
    };
    const t = tool({
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: (input, c) => `${input.text}:${c.toolCallId}`,
    });
    const result = await t.execute!({ text: "hi" }, ctx);
    expect(result).toBe("hi:call_1");
  });
});
