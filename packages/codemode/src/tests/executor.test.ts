/**
 * Tests for the Executor interface contract and DynamicWorkerExecutor.
 *
 * Uses vitest-pool-workers — tests run inside a real Workers runtime
 * with a real WorkerLoader binding, no mocks needed.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { RpcTarget } from "cloudflare:workers";
import {
  DynamicWorkerExecutor,
  ToolDispatcher,
  type SandboxPlugin
} from "../executor";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

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
});

describe("DynamicWorkerExecutor", () => {
  it("should execute simple code that returns a value", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 42", {});
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should call tool functions via codemode proxy", async () => {
    const add = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      return (input.a as number) + (input.b as number);
    });
    const fns: ToolFns = { add };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.add({ a: 3, b: 4 })",
      fns
    );

    expect(result.result).toBe(7);
    expect(add).toHaveBeenCalledWith({ a: 3, b: 4 });
  });

  it("should handle multiple sequential tool calls", async () => {
    const getWeather = vi.fn(async () => ({ temp: 72 }));
    const searchWeb = vi.fn(async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      return { results: [`news about ${input.query as string}`] };
    });
    const fns: ToolFns = { getWeather, searchWeb };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const code = `async () => {
      const weather = await codemode.getWeather({});
      const news = await codemode.searchWeb({ query: "temp " + weather.temp });
      return { weather, news };
    }`;

    const result = await executor.execute(code, fns);
    expect(result.result).toEqual({
      weather: { temp: 72 },
      news: { results: ["news about temp 72"] }
    });
    expect(getWeather).toHaveBeenCalledTimes(1);
    expect(searchWeb).toHaveBeenCalledTimes(1);
  });

  it("should return error when code throws", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { throw new Error("boom"); }',
      {}
    );
    expect(result.error).toBe("boom");
  });

  it("should return error when tool function throws", async () => {
    const fail = vi.fn(async () => {
      throw new Error("tool error");
    });
    const fns: ToolFns = { fail };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.fail({})",
      fns
    );
    expect(result.error).toBe("tool error");
  });

  it("should handle concurrent tool calls via Promise.all", async () => {
    const fns: ToolFns = {
      slow: async (...args: unknown[]) => {
        const input = args[0] as Record<string, unknown>;
        return { id: input.id as number };
      }
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

    const result = await executor.execute(code, fns);
    expect(result.result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("should capture console.log output", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { console.log("hello"); console.warn("careful"); return "done"; }',
      {}
    );

    expect(result.result).toBe("done");
    expect(result.logs).toContain("hello");
    expect(result.logs).toContain("[warn] careful");
  });

  it("should handle code containing backticks and template literals", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { return `hello ${"world"}`; }',
      {}
    );

    expect(result.result).toBe("hello world");
  });

  it("should block external fetch by default (globalOutbound: null)", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      'async () => { const r = await fetch("https://example.com"); return r.status; }',
      {}
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
      fns
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

    const result = await executor.execute(code, {});
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
    const result = await executor.execute("async () => 1 + 1", {});
    expect(result.result).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("should normalize code automatically (strip fences, wrap expressions)", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    // Code wrapped in markdown fences — should be stripped and normalized
    const result = await executor.execute("```js\n1 + 1\n```", {});
    expect(result.result).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("should normalize bare expressions into async arrow functions", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("42", {});
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should work with empty plugins array", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute("async () => 42", {}, []);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should sanitize tool names with hyphens and dots", async () => {
    const listIssues = vi.fn(async () => [{ id: 1, title: "bug" }]);
    const fns: ToolFns = {
      "github.list-issues": listIssues
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.github_list_issues({})",
      fns
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
      {}
    );

    expect(result.error).toContain("timed out");
  });
});

// ── SandboxPlugin tests ───────────────────────────────────────────────

/** Minimal plugin dispatcher for testing — echoes method calls back to the sandbox. */
class EchoDispatcher extends RpcTarget {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  async call(method: string, argsJson: string): Promise<string> {
    const args = argsJson ? (JSON.parse(argsJson) as unknown[]) : [];
    this.calls.push({ method, args });
    return JSON.stringify({ result: { echo: method, args } });
  }
}

function makeEchoPlugin(name: string): SandboxPlugin & {
  dispatcher: EchoDispatcher;
} {
  const dispatcher = new EchoDispatcher();
  return {
    name,
    dispatcher,
    module: {
      name: `${name}.js`,
      source: [
        `export function create${name.charAt(0).toUpperCase() + name.slice(1)}(dispatcher) {`,
        "  const invoke = async (method, ...args) => {",
        "    const res = await dispatcher.call(method, JSON.stringify(args));",
        "    const data = JSON.parse(res);",
        "    if (data.error) throw new Error(data.error);",
        "    return data.result;",
        "  };",
        "  return new Proxy({}, { get: (_, m) => (...a) => invoke(String(m), ...a) });",
        "}"
      ].join("\n")
    },
    createGlobal: (ref) => ({
      imports: `import { create${name.charAt(0).toUpperCase() + name.slice(1)} } from "${name}.js";`,
      init: `const ${name} = create${name.charAt(0).toUpperCase() + name.slice(1)}(${ref});`
    }),
    types: `declare const ${name}: Record<string, (...args: unknown[]) => Promise<unknown>>;`
  };
}

describe("SandboxPlugin", () => {
  it("exposes a named global via a plugin", async () => {
    const echo = makeEchoPlugin("echo");
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const r = await echo.ping("hello");
        return r;
      }`,
      {},
      [echo]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ echo: "ping", args: ["hello"] });
    expect(echo.dispatcher.calls).toHaveLength(1);
    expect(echo.dispatcher.calls[0]).toEqual({
      method: "ping",
      args: ["hello"]
    });
  });

  it("plugin global and codemode.* coexist in the same sandbox", async () => {
    const addFn = vi.fn(async (args: unknown) => {
      const { a, b } = args as { a: number; b: number };
      return a + b;
    });
    const echo = makeEchoPlugin("echo");
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const sum = await codemode.add({ a: 3, b: 4 });
        const pong = await echo.ping(sum);
        return { sum, pong };
      }`,
      { add: addFn as never },
      [echo]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      sum: 7,
      pong: { echo: "ping", args: [7] }
    });
    expect(addFn).toHaveBeenCalledWith({ a: 3, b: 4 });
  });

  it("multiple plugins each get their own global", async () => {
    const store = makeEchoPlugin("store");
    const cache = makeEchoPlugin("cache");
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const a = await store.get("key");
        const b = await cache.get("key");
        return { a, b };
      }`,
      {},
      [store, cache]
    );

    expect(result.error).toBeUndefined();
    expect(store.dispatcher.calls).toHaveLength(1);
    expect(cache.dispatcher.calls).toHaveLength(1);
    expect(store.dispatcher.calls[0]).toEqual({ method: "get", args: ["key"] });
    expect(cache.dispatcher.calls[0]).toEqual({ method: "get", args: ["key"] });
  });

  it("plugin module can be imported explicitly in sandbox code", async () => {
    const echo = makeEchoPlugin("echo");
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const { createEcho } = await import("echo.js");
        // plugin module is available for direct import too
        return typeof createEcho;
      }`,
      {},
      [echo]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("function");
  });

  it("plugin errors propagate as sandbox errors", async () => {
    const failing: SandboxPlugin = {
      name: "broken",
      dispatcher: new (class extends RpcTarget {
        async call(_method: string, _args: string): Promise<string> {
          return JSON.stringify({ error: "plugin failed" });
        }
      })(),
      createGlobal: (ref) => ({
        init: [
          `const broken = new Proxy({}, {`,
          `  get: (_, m) => async (...a) => {`,
          `    const r = await ${ref}.call(String(m), JSON.stringify(a));`,
          `    const d = JSON.parse(r);`,
          `    if (d.error) throw new Error(d.error);`,
          `    return d.result;`,
          `  }`,
          `});`
        ].join(" ")
      })
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => await broken.doSomething()`,
      {},
      [failing]
    );

    expect(result.error).toBe("plugin failed");
  });

  it("plugin types are accessible on the plugin descriptor", () => {
    const echo = makeEchoPlugin("echo");
    expect(echo.types).toContain("declare const echo");
  });
});
