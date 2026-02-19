/**
 * Tests for the Executor interface contract and DynamicWorkerExecutor.
 */
import { describe, it, expect, vi } from "vitest";
import { DynamicWorkerExecutor, ToolDispatcher } from "../executor";
import type {
  Executor,
  ExecuteResult,
  DynamicWorkerExecutorOptions
} from "../executor";

/**
 * A minimal in-process executor for testing.
 * Implements the Executor interface by running code via AsyncFunction
 * with the tool fns injected as `codemode`.
 */
class InProcessExecutor implements Executor {
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    try {
      const AsyncFunction = Object.getPrototypeOf(
        async function () {}
      ).constructor;
      const fn = new AsyncFunction("codemode", `return await (${code})()`);
      const result = await fn(fns);
      return { result };
    } catch (err) {
      return {
        result: undefined,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

describe("Executor interface", () => {
  const executor: Executor = new InProcessExecutor();

  it("should execute simple code that returns a value", async () => {
    const result = await executor.execute("async () => 42", {});
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it("should call tool functions via codemode", async () => {
    const fns = {
      add: vi.fn(async (args: any) => args.a + args.b)
    };

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

    const result = await executor.execute(
      "async () => await codemode.fail({})",
      fns
    );
    expect(result.error).toBe("tool error");
  });

  it("should preserve closures in tool functions", async () => {
    const secret = "api-key-123";
    const fns = {
      getSecret: async () => ({ key: secret })
    };

    const result = await executor.execute(
      "async () => await codemode.getSecret({})",
      fns
    );
    expect(result.result).toEqual({ key: "api-key-123" });
  });

  it("should handle concurrent tool calls", async () => {
    const fns = {
      slow: async (args: any) => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: args.id };
      }
    };

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
});

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

/** Captured config from the last loader.get call */
interface MockWorkerConfig {
  modules: Record<string, string>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
}

function createMockLoader() {
  let capturedConfig: MockWorkerConfig | null = null;
  let capturedDispatcher: ToolDispatcher | null = null;
  const mockLoader = {
    get: vi.fn((_name: string, factory: () => MockWorkerConfig) => {
      capturedConfig = factory();
      return {
        getEntrypoint: () => ({
          evaluate: async (dispatcher: ToolDispatcher) => {
            capturedDispatcher = dispatcher;
            return { result: null };
          }
        })
      };
    })
  };
  return {
    mockLoader,
    getConfig: () => capturedConfig!,
    getDispatcher: () => capturedDispatcher!
  };
}

describe("DynamicWorkerExecutor", () => {
  it("should pass ToolDispatcher to evaluate() via RPC", async () => {
    const executeFn = vi.fn(async (args: any) => ({
      doubled: args.n * 2
    }));

    const { mockLoader, getDispatcher } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    await executor.execute("async () => null", {
      double: executeFn
    });

    const dispatcher = getDispatcher();
    expect(dispatcher).toBeInstanceOf(ToolDispatcher);

    // Verify the dispatcher routes to our function
    const resJson = await dispatcher.call("double", JSON.stringify({ n: 5 }));
    const data = JSON.parse(resJson);
    expect(data.result).toEqual({ doubled: 10 });
    expect(executeFn).toHaveBeenCalledWith({ n: 5 });
  });

  it("should generate worker module that uses dispatcher.call() for tool calls", async () => {
    const { mockLoader, getConfig } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    await executor.execute("async () => null", {});

    const executorCode = getConfig().modules["executor.js"];
    expect(executorCode).toContain("dispatcher.call");
    expect(executorCode).toContain("Proxy");
    // Should NOT reference globalOutbound, codemode.internal, or env.outbound
    expect(executorCode).not.toContain("codemode.internal");
    expect(executorCode).not.toContain("globalOutbound");
    expect(executorCode).not.toContain("outbound");
    expect(executorCode).not.toContain("this.env");
  });

  it("should set globalOutbound to null by default (blocks external fetch)", async () => {
    const { mockLoader, getConfig } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    await executor.execute("async () => null", {});

    const config = getConfig();
    expect(config).toHaveProperty("globalOutbound", null);
  });

  it("should handle code containing backticks and template literal syntax", async () => {
    const { mockLoader, getConfig } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    const codeWithBackticks = 'async () => { return `hello ${"world"}`; }';
    await executor.execute(codeWithBackticks, {});

    const executorCode = getConfig().modules["executor.js"];
    // The code should be spliced in via string concatenation, not template literals,
    // so backticks and ${...} in the code don't break the module
    expect(executorCode).toContain(codeWithBackticks);
  });

  it("should include console override in generated module", async () => {
    const { mockLoader, getConfig } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    await executor.execute("async () => null", {});

    const executorCode = getConfig().modules["executor.js"];
    expect(executorCode).toContain("__logs");
    expect(executorCode).toContain("console.log");
    expect(executorCode).toContain("console.warn");
    expect(executorCode).toContain("console.error");
  });

  it("should include timeout in generated module", async () => {
    const { mockLoader, getConfig } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"],
      timeout: 5000
    });

    await executor.execute("async () => null", {});

    const executorCode = getConfig().modules["executor.js"];
    expect(executorCode).toContain("Promise.race");
    expect(executorCode).toContain("5000");
    expect(executorCode).toContain("Execution timed out");
  });

  it("should use default 30000ms timeout when not specified", async () => {
    const { mockLoader, getConfig } = createMockLoader();

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    await executor.execute("async () => null", {});

    const executorCode = getConfig().modules["executor.js"];
    expect(executorCode).toContain("30000");
  });

  it("should return logs from worker response", async () => {
    const mockLoader = {
      get: vi.fn((_name: string, factory: () => MockWorkerConfig) => {
        factory();
        return {
          getEntrypoint: () => ({
            evaluate: async () => ({
              result: "ok",
              logs: ["log line 1", "[warn] warning"]
            })
          })
        };
      })
    };

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    const result = await executor.execute("async () => null", {});
    expect(result.result).toBe("ok");
    expect(result.logs).toEqual(["log line 1", "[warn] warning"]);
  });

  it("should return error from worker response", async () => {
    const mockLoader = {
      get: vi.fn((_name: string, factory: () => MockWorkerConfig) => {
        factory(); // consume
        return {
          getEntrypoint: () => ({
            evaluate: async () => ({
              result: undefined,
              err: "runtime error"
            })
          })
        };
      })
    };

    const executor = new DynamicWorkerExecutor({
      loader: mockLoader as unknown as DynamicWorkerExecutorOptions["loader"]
    });

    const result = await executor.execute("async () => null", {});
    expect(result.error).toBe("runtime error");
    expect(result.result).toBeUndefined();
  });
});
