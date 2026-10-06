import { expectTypeOf } from "vitest";
import { z } from "zod";
import {
  defineExtension,
  defineTool,
  jsonSchema,
  type JsonObject,
  type ToolBeforeEvent
} from "../harness/extensions";

// A tool's execute input is what its schema parses to.
defineTool({
  id: "add",
  description: "Add.",
  input: z.object({ a: z.number(), b: z.number().optional() }),
  execute(input) {
    expectTypeOf(input).toEqualTypeOf<{ a: number; b?: number | undefined }>();
    return { content: String(input.a) };
  }
});

// A raw JSON Schema parses to a JSON object.
defineTool({
  id: "raw",
  description: "Raw.",
  input: jsonSchema({ type: "object" }),
  execute(input) {
    expectTypeOf(input).toEqualTypeOf<JsonObject>();
    return { content: "" };
  }
});

defineExtension({
  id: "typed",
  async setup(ctx) {
    // Hook events are typed by name.
    await ctx.tool.hook("execute.before", (event) => {
      expectTypeOf(event).toEqualTypeOf<ToolBeforeEvent>();
    });
    // @ts-expect-error unknown hook
    await ctx.tool.hook("execute.during", () => {});
    // @ts-expect-error tool ids are strings
    await ctx.tool.transform((draft) => draft.remove(1));
  }
});
