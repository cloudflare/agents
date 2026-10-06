import { expectTypeOf } from "vitest";
import { z } from "zod";
import {
  jsonSchema,
  tool,
  type Extension,
  type JsonObject,
  type ToolBeforeEvent
} from "../harness/extensions";

// A tool's execute input is what its schema parses to.
tool({
  id: "add",
  description: "Add.",
  input: z.object({ a: z.number(), b: z.number().optional() }),
  execute(input) {
    expectTypeOf(input).toEqualTypeOf<{ a: number; b?: number | undefined }>();
    return { content: String(input.a) };
  }
});

// A raw JSON Schema parses to a JSON object.
tool({
  id: "raw",
  description: "Raw.",
  input: jsonSchema({ type: "object" }),
  execute(input) {
    expectTypeOf(input).toEqualTypeOf<JsonObject>();
    return { content: "" };
  }
});

// An extension is a function of its context.
export const typed: Extension = (ctx) => {
  // ctx.tool.add infers the input inline.
  ctx.tool.add({
    id: "inline",
    description: "",
    input: z.object({ n: z.number() }),
    replay: "safe",
    async execute({ n }, call) {
      expectTypeOf(n).toEqualTypeOf<number>();
      const yes = await call.ask({ kind: "confirm", message: "?" });
      expectTypeOf(yes).toEqualTypeOf<boolean>();
      const pick = await call.ask({
        kind: "select",
        message: "?",
        options: ["a"]
      });
      expectTypeOf(pick).toEqualTypeOf<string>();
      return { content: "", metadata: { n } };
    }
  });
  ctx.tool.hook("execute.before", (event) => {
    expectTypeOf(event).toEqualTypeOf<ToolBeforeEvent>();
  });
  // @ts-expect-error unknown hook
  ctx.tool.hook("execute.during", () => {});
  // @ts-expect-error unknown event
  ctx.event.on("run.whatever", () => {});
  // @ts-expect-error storage holds JSON only
  ctx.storage("x").put("k", new Date());
};
