/**
 * Type-level tests for Think's tool-call lifecycle contexts.
 *
 * Verifies that passing an explicit `TOOLS` generic gives per-tool
 * narrowing: `ctx.input` on `beforeToolCall` and — new in #1343 — `ctx.output`
 * on `afterToolCall`'s success branch both narrow when discriminating on
 * `ctx.toolName`.
 *
 * Checked by the typecheck script, not vitest.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolCallContext, ToolCallResultContext } from "../think";

// Explicit `execute` return annotations so the inferred OUTPUT is concrete
// (the AI SDK infers INPUT and OUTPUT together, so without an annotation a
// primitive return can collapse to `any`).
const tools = {
  search: tool({
    description: "Search the web",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }): Promise<{ results: string[] }> => ({
      results: [query]
    })
  }),
  add: tool({
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }): Promise<number> => a + b
  })
};

// ── beforeToolCall: input narrows on toolName ───────────────────
function checkBeforeToolCall(ctx: ToolCallContext<typeof tools>) {
  if (ctx.toolName === "search") {
    const query: string = ctx.input.query;
    void query;

    // @ts-expect-error — the `search` input has no `a` field.
    void ctx.input.a;
  }
}
void checkBeforeToolCall;

// ── afterToolCall: output narrows on toolName when success ───────
function checkAfterToolCall(ctx: ToolCallResultContext<typeof tools>) {
  if (ctx.toolName === "search" && ctx.success) {
    const results: string[] = ctx.output.results;
    void results;

    // @ts-expect-error — `search` output is `{ results: string[] }`, not a number.
    const wrong: number = ctx.output;
    void wrong;
  }

  if (ctx.toolName === "add" && ctx.success) {
    const sum: number = ctx.output;
    void sum;

    // @ts-expect-error — `add` output is a number, not a string.
    const notString: string = ctx.output;
    void notString;
  }

  if (!ctx.success) {
    const error: unknown = ctx.error;
    void error;

    // On the failure branch `output` is `never` (optional) — reading it
    // yields only `undefined`, never a real tool output value.
    const noOutput: undefined = ctx.output;
    void noOutput;
  }
}
void checkAfterToolCall;

// ── Default ToolSet generic keeps output `unknown` (backward compatible) ──
function checkUntyped(ctx: ToolCallResultContext) {
  if (ctx.success) {
    const output: unknown = ctx.output;
    void output;
  }
}
void checkUntyped;
