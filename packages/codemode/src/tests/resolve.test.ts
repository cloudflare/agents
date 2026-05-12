/**
 * Tests for the framework-agnostic resolve module.
 *
 * Verifies that resolveProvider, filterTools, and extractFns work
 * without any dependency on the AI SDK or Zod.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveProvider, filterTools, extractFns } from "../resolve";
import type { ToolProvider, SimpleToolRecord } from "../executor";

describe("filterTools", () => {
  it("should pass through tools without needsApproval", () => {
    const tools: SimpleToolRecord = {
      safe: {
        description: "Safe tool",
        execute: async () => ({ ok: true })
      },
      alsoSafe: {
        description: "Also safe",
        execute: async () => ({ ok: true })
      }
    };

    const filtered = filterTools(tools);
    expect(Object.keys(filtered)).toEqual(["safe", "alsoSafe"]);
  });

  it("should filter out tools with needsApproval: true", () => {
    const tools = {
      safe: {
        description: "Safe tool",
        execute: async () => ({ ok: true })
      },
      dangerous: {
        description: "Dangerous tool",
        execute: async () => ({ deleted: true }),
        needsApproval: true
      }
    };

    const filtered = filterTools(tools);
    expect(Object.keys(filtered)).toEqual(["safe"]);
  });

  it("should filter out tools with needsApproval as a function", () => {
    const tools = {
      safe: {
        description: "Safe tool",
        execute: async () => ({})
      },
      conditional: {
        description: "Conditional approval",
        execute: async () => ({}),
        needsApproval: async () => true
      }
    };

    const filtered = filterTools(tools);
    expect(Object.keys(filtered)).toEqual(["safe"]);
  });

  it("should keep tools with needsApproval: false", () => {
    const tools = {
      safe: {
        description: "Explicitly safe tool",
        execute: async () => ({ ok: true }),
        needsApproval: false
      }
    };

    const filtered = filterTools(tools);
    expect(Object.keys(filtered)).toEqual(["safe"]);
  });

  it("should keep tools with needsApproval explicitly set to undefined in the shape but not actually present", () => {
    const tools: SimpleToolRecord = {
      tool: {
        description: "Tool",
        execute: async () => ({})
      }
    };

    const filtered = filterTools(tools);
    expect(Object.keys(filtered)).toEqual(["tool"]);
  });

  it("should return empty record for empty input", () => {
    const filtered = filterTools({} as SimpleToolRecord);
    expect(Object.keys(filtered)).toEqual([]);
  });
});

describe("extractFns", () => {
  it("should extract execute functions keyed by name", () => {
    const executeFn = vi.fn(async () => ({ result: "ok" }));
    const tools: SimpleToolRecord = {
      myTool: {
        description: "Test",
        execute: executeFn
      }
    };

    const fns = extractFns(tools);
    expect(Object.keys(fns)).toEqual(["myTool"]);
    expect(fns.myTool).toBeDefined();
  });

  it("should skip tools without execute", () => {
    const tools = {
      withExecute: {
        description: "Has execute",
        execute: async () => ({})
      },
      withoutExecute: {
        description: "No execute"
      }
    };

    const fns = extractFns(tools as unknown as SimpleToolRecord);
    expect(Object.keys(fns)).toEqual(["withExecute"]);
  });

  it("should call through to the original execute function", async () => {
    const executeFn = vi.fn(async (args: unknown) => ({
      received: args
    }));
    const tools: SimpleToolRecord = {
      echo: { description: "Echo", execute: executeFn }
    };

    const fns = extractFns(tools);
    const result = await fns.echo({ message: "hello" });

    expect(executeFn).toHaveBeenCalledWith({ message: "hello" });
    expect(result).toEqual({ received: { message: "hello" } });
  });

  it("should handle multiple tools", () => {
    const tools: SimpleToolRecord = {
      a: { description: "A", execute: async () => "a" },
      b: { description: "B", execute: async () => "b" },
      c: { description: "C", execute: async () => "c" }
    };

    const fns = extractFns(tools);
    expect(Object.keys(fns).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("resolveProvider", () => {
  it("should resolve with default 'codemode' namespace", () => {
    const provider: ToolProvider = {
      tools: {
        myTool: {
          description: "Test",
          execute: async () => ({})
        }
      } as SimpleToolRecord
    };

    const resolved = resolveProvider(provider);
    expect(resolved.name).toBe("codemode");
    expect(Object.keys(resolved.fns)).toEqual(["myTool"]);
  });

  it("should use custom namespace name", () => {
    const provider: ToolProvider = {
      name: "github",
      tools: {
        listIssues: {
          description: "List issues",
          execute: async () => []
        }
      } as SimpleToolRecord
    };

    const resolved = resolveProvider(provider);
    expect(resolved.name).toBe("github");
  });

  it("should filter out tools with needsApproval", () => {
    const provider: ToolProvider = {
      tools: {
        safe: {
          description: "Safe",
          execute: async () => ({})
        },
        dangerous: {
          description: "Dangerous",
          execute: async () => ({}),
          needsApproval: true
        }
      } as unknown as SimpleToolRecord
    };

    const resolved = resolveProvider(provider);
    expect(Object.keys(resolved.fns)).toEqual(["safe"]);
  });

  it("should preserve positionalArgs flag", () => {
    const provider: ToolProvider = {
      name: "state",
      tools: {
        readFile: {
          description: "Read file",
          execute: async () => ""
        }
      } as SimpleToolRecord,
      positionalArgs: true
    };

    const resolved = resolveProvider(provider);
    expect(resolved.positionalArgs).toBe(true);
  });

  it("should not set positionalArgs when not specified", () => {
    const provider: ToolProvider = {
      tools: {
        tool: {
          description: "Tool",
          execute: async () => ({})
        }
      } as SimpleToolRecord
    };

    const resolved = resolveProvider(provider);
    expect(resolved.positionalArgs).toBeUndefined();
  });

  it("should produce working execute functions", async () => {
    const spy = vi.fn(async (args: unknown) => ({ echo: args }));
    const provider: ToolProvider = {
      tools: {
        echo: { description: "Echo", execute: spy }
      } as SimpleToolRecord
    };

    const resolved = resolveProvider(provider);
    const result = await resolved.fns.echo({ msg: "hi" });

    expect(spy).toHaveBeenCalledWith({ msg: "hi" });
    expect(result).toEqual({ echo: { msg: "hi" } });
  });
});
