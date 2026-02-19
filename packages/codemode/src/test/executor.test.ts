/**
 * Tests for the Executor interface contract and DynamicWorkerExecutor.
 *
 * Uses vitest-pool-workers — tests run inside a real Workers runtime
 * with a real WorkerLoader binding, no mocks needed.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { DynamicWorkerExecutor, ToolDispatcher } from "../executor";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    LOADER: WorkerLoader;
  }
}

describe("ToolDispatcher", () => {
  it("should dispatch tool calls and return JSON result", async () => {
    const fns = {
      double: vi.fn(async (args: any) => ({ doubled: args.n * 2 }))
    };
    const dispatcher = new ToolDispatcher(fns);

    const resJson = await dispatcher.call("double", JSON.stringify({ n: 5 }));
    const data = JSON.parse(resJson);

    expect(data.result).toEqual({ doubled: 10 });
    expect(fns.double).toHaveBeenCalledWith({ n: 5 });
  });

  it("should return error for unknown tool", async () => {
    const dispatcher = new ToolDispatcher({});

    const resJson = await dispatcher.call("nonexistent", "{}");
    const data = JSON.parse(resJson);

    expect(data.error).toContain("nonexistent");
  });

  it("should return error when tool function throws", async () => {
    const fns = {
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
    const fns = {
      noArgs: vi.fn(async () => "ok")
    };
    const dispatcher = new ToolDispatcher(fns);

    const resJson = await dispatcher.call("noArgs", "");
    const data = JSON.parse(resJson);

    expect(data.result).toBe("ok");
    expect(fns.noArgs).toHaveBeenCalledWith({});
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
    const fns = {
      add: vi.fn(async (args: any) => args.a + args.b)
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.add({ a: 3, b: 4 })",
      fns
    );

    expect(result.result).toBe(7);
    expect(fns.add).toHaveBeenCalledWith({ a: 3, b: 4 });
  });

  it("should handle multiple sequential tool calls", async () => {
    const fns = {
      getWeather: vi.fn(async () => ({ temp: 72 })),
      searchWeb: vi.fn(async (args: any) => ({
        results: [`news about ${args.query}`]
      }))
    };
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
    expect(fns.getWeather).toHaveBeenCalledTimes(1);
    expect(fns.searchWeb).toHaveBeenCalledTimes(1);
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
    const fns = {
      fail: vi.fn(async () => {
        throw new Error("tool error");
      })
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.fail({})",
      fns
    );
    expect(result.error).toBe("tool error");
  });

  it("should handle concurrent tool calls via Promise.all", async () => {
    const fns = {
      slow: async (args: any) => {
        return { id: args.id };
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
    const fns = {
      getSecret: async () => ({ key: secret })
    };
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      "async () => await codemode.getSecret({})",
      fns
    );
    expect(result.result).toEqual({ key: "api-key-123" });
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
