/**
 * Tests for the Executor interface contract and DynamicWorkerExecutor.
 *
 * Uses vitest-pool-workers — tests run inside a real Workers runtime
 * with a real WorkerLoader binding, no mocks needed.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  DynamicWorkerExecutor,
  ToolDispatcher,
  type ResolvedProvider
} from "../executor";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** Helper to wrap raw fns into the default "codemode" provider. */
function codemodeProvider(fns: ToolFns): ResolvedProvider {
  return { name: "codemode", fns };
}

describe("ToolDispatcher", () => {
  it("should dispatch tool calls and return JSON result", async () => {
    const double = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      return { doubled: (input.n as number) * 2 };
    });
    const fns: ToolFns = { double };
    const dispatcher = new ToolDispatcher(fns);

    const resJson = await dispatcher.call("double", JSON.stringify({ n: 5 }));
    const data = JSON.parse(resJson);

    expect(data.result).toEqual({ doubled: 10 });
    expect(double).toHaveBeenCalledWith({ n: 5 });
  });

  it("should return error for unknown tool", async () => {
    const dispatcher = new ToolDispatcher({});

    const resJson = await dispatcher.call("nonexistent", "{}");
    const data = JSON.parse(resJson);

    expect(data.error).toContain("nonexistent");
  });

  it("should return error when tool function throws", async () => {
    const fns: ToolFns = {
      broken: async () => {
        throw new Error("something broke");
      }
    };
    const dispatcher = new ToolDispatcher(fns);

    const resJson = await dispatcher.call("broken", "{}");
    const data = JSON.parse(resJson);

    expect(data.error).toBe("something broke");
  });

  it("should handle empty args string", async () => {
    const noArgs = vi.fn(async () => "ok");
    const fns: ToolFns = { noArgs };
    const dispatcher = new ToolDispatcher(fns);

    const resJson = await dispatcher.call("noArgs", "");
    const data = JSON.parse(resJson);

    expect(data.result).toBe("ok");
    expect(noArgs).toHaveBeenCalledWith({});
  });

  it("should preserve Uint8Array results", async () => {
    const dispatcher = new ToolDispatcher({
      bytes: async () => new Uint8Array([1, 2, 3])
    });

    const resJson = await dispatcher.call("bytes", "{}");
    const data = JSON.parse(resJson);

    expect(data.result).toEqual({
      __codemode_binary_v1__: "Uint8Array",
      data: "AQID"
    });
  });
});

describe("DynamicWorkerExecutor", () => {
  it("should execute simple code that returns a value", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 42", [
      codemodeProvider({})
    ]);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should call tool functions via codemode proxy", async () => {
    const add = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      return (input.a as number) + (input.b as number);
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.add({ a: 3, b: 4 })",
      [codemodeProvider({ add })]
    );

    expect(result.result).toBe(7);
    expect(add).toHaveBeenCalledWith({ a: 3, b: 4 });
  });

  it("should preserve Uint8Array tool arguments and results", async () => {
    const accept = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as { bytes: Uint8Array };
      expect(input.bytes).toBeInstanceOf(Uint8Array);
      return input.bytes;
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const bytes = await codemode.accept({ bytes: new Uint8Array([1, 2, 3]) });
        return { isBytes: bytes instanceof Uint8Array, values: Array.from(bytes) };
      }`,
      [codemodeProvider({ accept })]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ isBytes: true, values: [1, 2, 3] });
  });

  it("should preserve Uint8Array positional tool arguments and results", async () => {
    const accept = vi.fn(async (...args: unknown[]) => {
      const [path, bytes] = args as [string, Uint8Array];
      expect(path).toBe("/x.bin");
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(bytes)).toEqual([1, 2, 3]);
      return bytes;
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const bytes = await state.accept("/x.bin", new Uint8Array([1, 2, 3]));
        return { isBytes: bytes instanceof Uint8Array, values: Array.from(bytes) };
      }`,
      [{ name: "state", fns: { accept }, positionalArgs: true }]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ isBytes: true, values: [1, 2, 3] });
  });

  it("should preserve ArrayBuffer tool arguments and results", async () => {
    const accept = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as { buffer: ArrayBuffer };
      expect(input.buffer).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(input.buffer))).toEqual([4, 5, 6]);
      return input.buffer;
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const buffer = await codemode.accept({
          buffer: new Uint8Array([4, 5, 6]).buffer
        });
        return {
          isBuffer: buffer instanceof ArrayBuffer,
          values: Array.from(new Uint8Array(buffer))
        };
      }`,
      [codemodeProvider({ accept })]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ isBuffer: true, values: [4, 5, 6] });
  });

  it("should preserve only visible bytes from ArrayBuffer views", async () => {
    const accept = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as { bytes: Uint8Array };
      expect(input.bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(input.bytes)).toEqual([20, 30]);
      return input.bytes;
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const source = new Uint8Array([10, 20, 30, 40]);
        const view = source.subarray(1, 3);
        const bytes = await codemode.accept({ bytes: view });
        return Array.from(bytes);
      }`,
      [codemodeProvider({ accept })]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([20, 30]);
  });

  it("should handle multiple sequential tool calls", async () => {
    const getWeather = vi.fn(async () => ({ temp: 72 }));
    const searchWeb = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      return { results: [`news about ${input.query as string}`] };
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const code = `async () => {
      const weather = await codemode.getWeather({});
      const news = await codemode.searchWeb({ query: "temp " + weather.temp });
      return { weather, news };
    }`;

    const result = await executor.execute(code, [
      codemodeProvider({ getWeather, searchWeb })
    ]);
    expect(result.result).toEqual({
      weather: { temp: 72 },
      news: { results: ["news about temp 72"] }
    });
    expect(getWeather).toHaveBeenCalledTimes(1);
    expect(searchWeb).toHaveBeenCalledTimes(1);
  });

  it("should return a clear error for provider names reserved by the sandbox codec", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 42", [
      { name: "__stringifyForCodemode", fns: {} }
    ]);

    expect(result.error).toBe(
      'Provider name "__stringifyForCodemode" is reserved'
    );
  });

  it("should return error when code throws", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { throw new Error("boom"); }',
      [codemodeProvider({})]
    );
    expect(result.error).toBe("boom");
  });

  it("should return error when tool function throws", async () => {
    const fail = vi.fn(async () => {
      throw new Error("tool error");
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.fail({})",
      [codemodeProvider({ fail })]
    );
    expect(result.error).toBe("tool error");
  });

  it("should handle concurrent tool calls via Promise.all", async () => {
    const slow = async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      return { id: input.id as number };
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const code = `async () => {
      const [a, b, c] = await Promise.all([
        codemode.slow({ id: 1 }),
        codemode.slow({ id: 2 }),
        codemode.slow({ id: 3 })
      ]);
      return [a, b, c];
    }`;

    const result = await executor.execute(code, [codemodeProvider({ slow })]);
    expect(result.result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("should capture console.log output", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { console.log("hello"); console.warn("careful"); return "done"; }',
      [codemodeProvider({})]
    );

    expect(result.result).toBe("done");
    expect(result.logs).toContain("hello");
    expect(result.logs).toContain("[warn] careful");
  });

  it("should handle code containing backticks and template literals", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { return `hello ${"world"}`; }',
      [codemodeProvider({})]
    );

    expect(result.result).toBe("hello world");
  });

  it("should block external fetch by default (globalOutbound: null)", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { const r = await fetch("https://example.com"); return r.status; }',
      [codemodeProvider({})]
    );

    // fetch should fail because globalOutbound defaults to null
    expect(result.error).toBeDefined();
  });

  it("should preserve closures in tool functions", async () => {
    const secret = "api-key-123";
    const fns: ToolFns = {
      getSecret: async () => ({ key: secret })
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.getSecret({})",
      [codemodeProvider(fns)]
    );
    expect(result.result).toEqual({ key: "api-key-123" });
  });

  it("should make custom modules importable in sandbox code", async () => {
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      modules: {
        "helpers.js": 'export function greet(name) { return "hello " + name; }'
      }
    });

    const code = `async () => {
      const { greet } = await import("helpers.js");
      return greet("world");
    }`;

    const result = await executor.execute(code, [codemodeProvider({})]);
    expect(result.result).toBe("hello world");
    expect(result.error).toBeUndefined();
  });

  it("should not allow custom modules to override executor.js", async () => {
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      modules: {
        "executor.js": "export default class Evil {}"
      }
    });

    // Should still work normally — the reserved key is ignored
    const result = await executor.execute("async () => 1 + 1", [
      codemodeProvider({})
    ]);
    expect(result.result).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("should normalize code automatically (strip fences, wrap expressions)", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    // Code wrapped in markdown fences — should be stripped and normalized
    const result = await executor.execute("```js\n1 + 1\n```", [
      codemodeProvider({})
    ]);
    expect(result.result).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("should normalize bare expressions into async arrow functions", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("42", [codemodeProvider({})]);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should work with empty providers array", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 42", []);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should sanitize tool names with hyphens and dots", async () => {
    const listIssues = vi.fn(async () => [{ id: 1, title: "bug" }]);
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    // Note: sanitization happens in createCodeTool (tool.ts), not the executor.
    // The executor receives pre-sanitized names.
    const result = await executor.execute(
      "async () => await codemode.github_list_issues({})",
      [codemodeProvider({ github_list_issues: listIssues })]
    );

    expect(result.result).toEqual([{ id: 1, title: "bug" }]);
    expect(listIssues).toHaveBeenCalledWith({});
  });

  it("should include timeout in execution", async () => {
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      timeout: 100
    });

    const result = await executor.execute(
      "async () => { await new Promise(r => setTimeout(r, 5000)); return 'done'; }",
      [codemodeProvider({})]
    );

    expect(result.error).toContain("timed out");
  });
});

// ── Multiple provider tests ──────────────────────────────────────────

describe("Multiple providers (namespaces)", () => {
  it("exposes tools under a named provider namespace", async () => {
    const echo = vi.fn(async (args: unknown) => {
      const { msg } = args as { msg: string };
      return { echoed: msg };
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => await myns.echo({ msg: "hello" })`,
      [{ name: "myns", fns: { echo } }]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ echoed: "hello" });
    expect(echo).toHaveBeenCalledWith({ msg: "hello" });
  });

  it("multiple providers each get their own namespace", async () => {
    const storeGet = vi.fn(async () => ({ from: "store" }));
    const cacheGet = vi.fn(async () => ({ from: "cache" }));
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const a = await store.get({});
        const b = await cache.get({});
        return { a, b };
      }`,
      [
        { name: "store", fns: { get: storeGet } },
        { name: "cache", fns: { get: cacheGet } }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      a: { from: "store" },
      b: { from: "cache" }
    });
    expect(storeGet).toHaveBeenCalledTimes(1);
    expect(cacheGet).toHaveBeenCalledTimes(1);
  });

  it("named provider and codemode.* coexist in the same sandbox", async () => {
    const addFn = vi.fn(async (args: unknown) => {
      const { a, b } = args as { a: number; b: number };
      return a + b;
    });
    const echoFn = vi.fn(async (args: unknown) => {
      const { msg } = args as { msg: unknown };
      return { echoed: msg };
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const sum = await codemode.add({ a: 3, b: 4 });
        const pong = await echo.ping({ msg: sum });
        return { sum, pong };
      }`,
      [
        { name: "codemode", fns: { add: addFn } },
        { name: "echo", fns: { ping: echoFn } }
      ]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      sum: 7,
      pong: { echoed: 7 }
    });
    expect(addFn).toHaveBeenCalledWith({ a: 3, b: 4 });
  });

  it("provider errors propagate as sandbox errors", async () => {
    const failing = async () => {
      throw new Error("provider failed");
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => await broken.doSomething({})`,
      [{ name: "broken", fns: { doSomething: failing } }]
    );

    expect(result.error).toBe("provider failed");
  });

  it("rejects duplicate provider names", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 1", [
      { name: "dup", fns: {} },
      { name: "dup", fns: {} }
    ]);

    expect(result.error).toContain("Duplicate");
  });

  it("rejects sanitized tool name collisions", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 1", [
      {
        name: "codemode",
        fns: {
          "foo-bar": async () => "hyphen",
          foo_bar: async () => "underscore"
        }
      }
    ]);

    expect(result.error).toContain("both sanitize to");
  });

  it("rejects reserved provider names", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 1", [
      { name: "__dispatchers", fns: {} }
    ]);

    expect(result.error).toContain("reserved");
  });
});
