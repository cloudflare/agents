import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AbortedError } from "../../kernel/errors.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { tool, type Tool, type ToolExecutionContext } from "./types.js";
import { assembleTools, type ToolHooks } from "./registry.js";

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "call_1",
    requestId: "req_1",
    messages: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("assembleTools — merge precedence", () => {
  it("later sources win on name collision: builtin < external < actions < user", () => {
    const mk = (label: string): Tool => tool({ description: label, inputSchema: z.object({}) });
    const assembled = assembleTools(
      {
        builtin: { x: mk("builtin") },
        external: { x: mk("external") },
        actions: { x: mk("actions") },
        user: { x: mk("user") },
      },
      { clock: createTestClock() }
    );
    expect(assembled.tools.x!.description).toBe("user");
  });

  it("a client tool with a unique name is added", () => {
    const assembled = assembleTools(
      { builtin: { a: tool({ description: "a", inputSchema: z.object({}) }) }, client: { b: tool({ description: "b", inputSchema: z.object({}) }) } },
      { clock: createTestClock() }
    );
    expect(Object.keys(assembled.tools).sort()).toEqual(["a", "b"]);
  });

  it("a client tool colliding with a server tool name is dropped, server tool wins", () => {
    const assembled = assembleTools(
      {
        builtin: { a: tool({ description: "server", inputSchema: z.object({}) }) },
        client: { a: tool({ description: "client", inputSchema: z.object({}) }) },
      },
      { clock: createTestClock() }
    );
    expect(assembled.tools.a!.description).toBe("server");
  });

  it("actions override builtins and externals but user tools win over actions", () => {
    const mk = (label: string): Tool => tool({ description: label, inputSchema: z.object({}) });
    const assembled = assembleTools(
      { builtin: { a: mk("builtin"), b: mk("builtin-b") }, actions: { a: mk("action") }, user: { b: mk("user-b") } },
      { clock: createTestClock() }
    );
    expect(assembled.tools.a!.description).toBe("action");
    expect(assembled.tools.b!.description).toBe("user-b");
  });
});

describe("assembleTools — before-hook decisions", () => {
  function makeEchoTool(): Tool<{ v: number }, number> {
    return tool({
      description: "echo",
      inputSchema: z.object({ v: z.number() }),
      execute: (input) => input.v,
    });
  }

  it("allow (no decision) runs execute with the original input", async () => {
    const assembled = assembleTools({ builtin: { echo: makeEchoTool() } }, { clock: createTestClock() });
    const result = await assembled.execute("echo", { v: 3 }, ctx());
    expect(result).toEqual({ output: 3, isError: false });
  });

  it("allow with substituted input runs execute with the new input", async () => {
    const hooks: ToolHooks = {
      beforeToolCall: () => ({ action: "allow", input: { v: 99 } }),
    };
    const assembled = assembleTools({ builtin: { echo: makeEchoTool() } }, { hooks, clock: createTestClock() });
    const result = await assembled.execute("echo", { v: 3 }, ctx());
    expect(result).toEqual({ output: 99, isError: false });
  });

  it("block skips execute and returns the bare reason", async () => {
    const executeSpy = vi.fn((input: { v: number }) => input.v);
    const t = tool({ description: "echo", inputSchema: z.object({ v: z.number() }), execute: executeSpy });
    const hooks: ToolHooks = { beforeToolCall: () => ({ action: "block", reason: "not allowed" }) };
    const assembled = assembleTools({ builtin: { echo: t } }, { hooks, clock: createTestClock() });
    const result = await assembled.execute("echo", { v: 3 }, ctx());
    expect(result).toEqual({ output: "not allowed", isError: false });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("substitute skips execute and returns the provided output", async () => {
    const executeSpy = vi.fn((input: { v: number }) => input.v);
    const t = tool({ description: "echo", inputSchema: z.object({ v: z.number() }), execute: executeSpy });
    const hooks: ToolHooks = { beforeToolCall: () => ({ action: "substitute", output: { cached: true } }) };
    const assembled = assembleTools({ builtin: { echo: t } }, { hooks, clock: createTestClock() });
    const result = await assembled.execute("echo", { v: 3 }, ctx());
    expect(result).toEqual({ output: { cached: true }, isError: false });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("beforeToolCall receives toolName, toolCallId, input, stepNumber, messages, signal", async () => {
    let seen: unknown;
    const hooks: ToolHooks = {
      beforeToolCall: (c) => {
        seen = c;
      },
    };
    const t = tool({ description: "echo", inputSchema: z.object({ v: z.number() }), execute: (i: { v: number }) => i.v });
    const assembled = assembleTools({ builtin: { echo: t } }, { hooks, clock: createTestClock() });
    const c = ctx();
    await assembled.execute("echo", { v: 1 }, c);
    expect(seen).toMatchObject({ toolName: "echo", toolCallId: "call_1", input: { v: 1 }, stepNumber: 0 });
  });
});

describe("assembleTools — after-hook", () => {
  it("fires with success: true and output, plus timing, on a successful call", async () => {
    const clock = createTestClock(1000);
    const calls: unknown[] = [];
    const hooks: ToolHooks = {
      afterToolCall: (c) => {
        calls.push(c);
      },
    };
    const t = tool({
      description: "slow",
      inputSchema: z.object({}),
      execute: () => {
        clock.advance(50);
        return "done";
      },
    });
    const assembled = assembleTools({ builtin: { slow: t } }, { hooks, clock });
    await assembled.execute("slow", {}, ctx());
    expect(calls).toEqual([
      {
        toolName: "slow",
        toolCallId: "call_1",
        input: {},
        stepNumber: 0,
        durationMs: 50,
        success: true,
        output: "done",
      },
    ]);
  });

  it("fires with success: false and an ErrorValue when execute throws", async () => {
    const calls: unknown[] = [];
    const hooks: ToolHooks = {
      afterToolCall: (c) => {
        calls.push(c);
      },
    };
    const t = tool({
      description: "boom",
      inputSchema: z.object({}),
      execute: () => {
        throw new Error("kaboom");
      },
    });
    const assembled = assembleTools({ builtin: { boom: t } }, { hooks, clock: createTestClock() });
    const result = await assembled.execute("boom", {}, ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toEqual({ error: { name: "Error", message: "kaboom" } });
    expect(calls).toEqual([
      {
        toolName: "boom",
        toolCallId: "call_1",
        input: {},
        stepNumber: 0,
        durationMs: 0,
        success: false,
        error: { name: "Error", message: "kaboom" },
      },
    ]);
  });

  it("fires for block decisions even though execute never ran", async () => {
    const calls: unknown[] = [];
    const hooks: ToolHooks = {
      beforeToolCall: () => ({ action: "block", reason: "no" }),
      afterToolCall: (c) => {
        calls.push(c);
      },
    };
    const t = tool({ description: "echo", inputSchema: z.object({}), execute: () => "x" });
    const assembled = assembleTools({ builtin: { echo: t } }, { hooks, clock: createTestClock() });
    await assembled.execute("echo", {}, ctx());
    expect(calls).toEqual([
      {
        toolName: "echo",
        toolCallId: "call_1",
        input: {},
        stepNumber: 0,
        durationMs: 0,
        success: true,
        output: "no",
      },
    ]);
  });

  it("a thrown AbortedError propagates out of execute() instead of becoming an error value", async () => {
    const t = tool({
      description: "aborting",
      inputSchema: z.object({}),
      execute: () => {
        throw new AbortedError("cancelled");
      },
    });
    const assembled = assembleTools({ builtin: { aborting: t } }, { clock: createTestClock() });
    await expect(assembled.execute("aborting", {}, ctx())).rejects.toBeInstanceOf(AbortedError);
  });

  it("AbortedError propagation also applies through the wrapped tools ToolSet execute", async () => {
    const t = tool({
      description: "aborting",
      inputSchema: z.object({}),
      execute: () => {
        throw new AbortedError("cancelled");
      },
    });
    const assembled = assembleTools({ builtin: { aborting: t } }, { clock: createTestClock() });
    await expect(assembled.tools.aborting!.execute!({}, ctx())).rejects.toBeInstanceOf(AbortedError);
  });
});

describe("assembleTools — zod validation", () => {
  it("invalid input produces an error value output, not a thrown exception", async () => {
    const t = tool({
      description: "typed",
      inputSchema: z.object({ n: z.number() }),
      execute: (input: { n: number }) => input.n,
    });
    const assembled = assembleTools({ builtin: { typed: t } }, { clock: createTestClock() });
    const result = await assembled.execute("typed", { n: "not a number" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toMatchObject({ error: { name: "ToolInputValidationError" } });
  });

  it("valid input passes through parsed/coerced values to execute", async () => {
    const t = tool({
      description: "typed",
      inputSchema: z.object({ n: z.number().default(7) }),
      execute: (input: { n: number }) => input.n,
    });
    const assembled = assembleTools({ builtin: { typed: t } }, { clock: createTestClock() });
    const result = await assembled.execute("typed", {}, ctx());
    expect(result).toEqual({ output: 7, isError: false });
  });

  it("the jsonSchema passthrough form skips zod validation", async () => {
    const t: Tool = {
      description: "raw",
      inputSchema: { jsonSchema: { type: "object" } },
      execute: (input: unknown) => input,
    };
    const assembled = assembleTools({ builtin: { raw: t } }, { clock: createTestClock() });
    const result = await assembled.execute("raw", { anything: true }, ctx());
    expect(result).toEqual({ output: { anything: true }, isError: false });
  });
});

describe("assembleTools — filtering", () => {
  it("filter can remove tools", () => {
    const a = tool({ description: "a", inputSchema: z.object({}) });
    const b = tool({ description: "b", inputSchema: z.object({}) });
    const assembled = assembleTools(
      { builtin: { a, b } },
      {
        clock: createTestClock(),
        filter: (all) => {
          const { b: _drop, ...rest } = all;
          return rest;
        },
      }
    );
    expect(Object.keys(assembled.tools)).toEqual(["a"]);
  });

  it("a filter that adds a tool not present in the merged set throws", () => {
    const a = tool({ description: "a", inputSchema: z.object({}) });
    const extra = tool({ description: "extra", inputSchema: z.object({}) });
    expect(() =>
      assembleTools(
        { builtin: { a } },
        {
          clock: createTestClock(),
          filter: (all) => ({ ...all, extra }),
        }
      )
    ).toThrow();
  });
});

describe("assembleTools — activeTools narrowing in descriptors()", () => {
  it("descriptors() with no argument returns every assembled tool", () => {
    const a = tool({ description: "a", inputSchema: z.object({}) });
    const b = tool({ description: "b", inputSchema: z.object({}) });
    const assembled = assembleTools({ builtin: { a, b } }, { clock: createTestClock() });
    expect(assembled.descriptors().map((d) => d.name).sort()).toEqual(["a", "b"]);
  });

  it("descriptors(activeTools) narrows to the given names", () => {
    const a = tool({ description: "a", inputSchema: z.object({}) });
    const b = tool({ description: "b", inputSchema: z.object({}) });
    const assembled = assembleTools({ builtin: { a, b } }, { clock: createTestClock() });
    expect(assembled.descriptors(["a"]).map((d) => d.name)).toEqual(["a"]);
  });

  it("descriptors(activeTools) ignores names that are not in the assembled set", () => {
    const a = tool({ description: "a", inputSchema: z.object({}) });
    const assembled = assembleTools({ builtin: { a } }, { clock: createTestClock() });
    expect(assembled.descriptors(["a", "nonexistent"]).map((d) => d.name)).toEqual(["a"]);
  });
});

describe("assembleTools — descriptor conversion (zod object schemas)", () => {
  it("produces JSON schema for string/number/enum/optional fields", () => {
    const t = tool({
      description: "search",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
        mode: z.enum(["fast", "slow"]),
      }),
    });
    const assembled = assembleTools({ builtin: { search: t } }, { clock: createTestClock() });
    const [descriptor] = assembled.descriptors();
    expect(descriptor).toEqual({
      name: "search",
      description: "search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          mode: { type: "string", enum: ["fast", "slow"] },
        },
        required: ["query", "mode"],
      },
    });
  });
});

describe("assembleTools — isClientTool", () => {
  it("a tool with no execute is a client tool", () => {
    const clientTool = tool({ description: "client", inputSchema: z.object({}) });
    const serverTool = tool({ description: "server", inputSchema: z.object({}), execute: () => "ok" });
    const assembled = assembleTools({ client: { c: clientTool }, builtin: { s: serverTool } }, { clock: createTestClock() });
    expect(assembled.isClientTool("c")).toBe(true);
    expect(assembled.isClientTool("s")).toBe(false);
  });

  it("returns false for an unknown tool name", () => {
    const assembled = assembleTools({}, { clock: createTestClock() });
    expect(assembled.isClientTool("nope")).toBe(false);
  });
});

describe("assembleTools — needsApproval", () => {
  it("resolves a boolean needsApproval as-is", async () => {
    const t = tool({ description: "t", inputSchema: z.object({}), execute: () => "x", needsApproval: true });
    const assembled = assembleTools({ builtin: { t } }, { clock: createTestClock() });
    expect(await assembled.needsApproval("t", {})).toBe(true);
  });

  it("defaults to false when needsApproval is not set", async () => {
    const t = tool({ description: "t", inputSchema: z.object({}), execute: () => "x" });
    const assembled = assembleTools({ builtin: { t } }, { clock: createTestClock() });
    expect(await assembled.needsApproval("t", {})).toBe(false);
  });

  it("invokes a function needsApproval with the input and awaits it", async () => {
    const t = tool({
      description: "t",
      inputSchema: z.object({ danger: z.boolean() }),
      execute: (i: { danger: boolean }) => i.danger,
      needsApproval: (input: { danger: boolean }) => input.danger,
    });
    const assembled = assembleTools({ builtin: { t } }, { clock: createTestClock() });
    expect(await assembled.needsApproval("t", { danger: true })).toBe(true);
    expect(await assembled.needsApproval("t", { danger: false })).toBe(false);
  });

  it("returns false for an unknown tool name", async () => {
    const assembled = assembleTools({}, { clock: createTestClock() });
    expect(await assembled.needsApproval("nope", {})).toBe(false);
  });
});

describe("assembleTools — capabilityBlock", () => {
  function mkTool(capability?: string): Tool {
    return tool({
      description: "d",
      inputSchema: z.object({}),
      execute: () => "x",
      metadata: capability ? { capability } : undefined,
    });
  }

  it("groups tools by metadata.capability, omitting families with no members", () => {
    const assembled = assembleTools(
      {
        builtin: {
          read_file: mkTool("workspace"),
          write_file: mkTool("workspace"),
          run_skill: mkTool("skills"),
        },
      },
      { clock: createTestClock() }
    );
    const block = assembled.capabilityBlock();
    expect(block).toContain("workspace");
    expect(block).toContain("read_file");
    expect(block).toContain("write_file");
    expect(block).toContain("skills");
    expect(block).toContain("run_skill");
    expect(block).not.toContain("execution");
    expect(block).not.toContain("delegation");
  });

  it("omits tools with no metadata.capability entirely", () => {
    const assembled = assembleTools(
      { builtin: { plain: mkTool(undefined), grouped: mkTool("execution") } },
      { clock: createTestClock() }
    );
    const block = assembled.capabilityBlock();
    expect(block).not.toContain("plain");
    expect(block).toContain("execution");
  });

  it("is empty when no tool declares a capability", () => {
    const assembled = assembleTools({ builtin: { plain: mkTool(undefined) } }, { clock: createTestClock() });
    expect(assembled.capabilityBlock()).toBe("");
  });

  it("is stable/deterministic across repeated calls and independent of source key order", () => {
    const assembled1 = assembleTools(
      { builtin: { b: mkTool("workspace"), a: mkTool("workspace") } },
      { clock: createTestClock() }
    );
    const assembled2 = assembleTools(
      { builtin: { a: mkTool("workspace"), b: mkTool("workspace") } },
      { clock: createTestClock() }
    );
    expect(assembled1.capabilityBlock()).toBe(assembled1.capabilityBlock());
    expect(assembled1.capabilityBlock()).toBe(assembled2.capabilityBlock());
  });
});

describe("assembleTools — tools ToolSet is directly usable", () => {
  it("wrapped execute converts a thrown error into a returned error value (not a rejected promise)", async () => {
    const t = tool({
      description: "boom",
      inputSchema: z.object({}),
      execute: () => {
        throw new Error("kaboom");
      },
    });
    const assembled = assembleTools({ builtin: { boom: t } }, { clock: createTestClock() });
    const output = await assembled.tools.boom!.execute!({}, ctx());
    expect(output).toEqual({ error: { name: "Error", message: "kaboom" } });
  });

  it("preserves non-execute fields (needsApproval, metadata) on wrapped tools", () => {
    const t = tool({
      description: "d",
      inputSchema: z.object({}),
      execute: () => "x",
      needsApproval: true,
      metadata: { capability: "execution" },
    });
    const assembled = assembleTools({ builtin: { t } }, { clock: createTestClock() });
    expect(assembled.tools.t!.needsApproval).toBe(true);
    expect(assembled.tools.t!.metadata).toEqual({ capability: "execution" });
  });
});

describe("assembleTools — empty sources", () => {
  it("assembles to an empty tool set when no sources are given", () => {
    const assembled = assembleTools({}, { clock: createTestClock() });
    expect(assembled.tools).toEqual({});
    expect(assembled.descriptors()).toEqual([]);
  });
});
