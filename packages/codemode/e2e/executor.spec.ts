import { test, expect } from "@playwright/test";

/**
 * Deterministic e2e tests for the codemode executor pipeline.
 *
 * These bypass the LLM entirely — they POST raw code to the /execute
 * endpoint and verify the result. This tests the full HTTP → Worker →
 * WorkerLoader → dynamic sandbox → RPC dispatch → result pipeline.
 */

async function execute(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  code: string,
  preset = "default"
): Promise<{ result?: unknown; error?: string; logs?: string[] }> {
  const res = await request.post(`${baseURL}/execute`, {
    headers: { "Content-Type": "application/json" },
    data: { code, preset }
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

async function mcpExecute(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  code: string
): Promise<{ text: string; isError: boolean }> {
  const res = await request.post(`${baseURL}/mcp/execute`, {
    headers: { "Content-Type": "application/json" },
    data: { code }
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

// ── Basic execution ───────────────────────────────────────────────

test.describe("Direct executor e2e", () => {
  test("simple expression returns result", async ({ request, baseURL }) => {
    const result = await execute(request, baseURL!, "async () => 42");
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  test("bare expression is normalized and executed", async ({
    request,
    baseURL
  }) => {
    const result = await execute(request, baseURL!, "1 + 1");
    expect(result.result).toBe(2);
    expect(result.error).toBeUndefined();
  });

  test("markdown fences are stripped", async ({ request, baseURL }) => {
    const result = await execute(
      request,
      baseURL!,
      "```js\nasync () => 99\n```"
    );
    expect(result.result).toBe(99);
    expect(result.error).toBeUndefined();
  });

  test("tool call via default codemode namespace", async ({
    request,
    baseURL
  }) => {
    const result = await execute(
      request,
      baseURL!,
      "async () => await codemode.addNumbers({ a: 3, b: 4 })"
    );
    expect(result.result).toEqual({ result: 7 });
    expect(result.error).toBeUndefined();
  });

  test("multiple sequential tool calls", async ({ request, baseURL }) => {
    const code = `async () => {
      const w = await codemode.getWeather({ city: "NYC" });
      const sum = await codemode.addNumbers({ a: w.temperature, b: 10 });
      return { weather: w, sum: sum.result };
    }`;
    const result = await execute(request, baseURL!, code);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      weather: { city: "NYC", temperature: 22, condition: "Sunny" },
      sum: 32
    });
  });
});

// ── Multi-provider namespaces ─────────────────────────────────────

test.describe("Multi-provider namespaces e2e", () => {
  test("code can call tools from two different namespaces", async ({
    request,
    baseURL
  }) => {
    const code = `async () => {
      const w = await codemode.getWeather({ city: "Berlin" });
      const product = await math.multiply({ a: w.temperature, b: 3 });
      return { city: w.city, tripled: product.result };
    }`;
    const result = await execute(request, baseURL!, code, "multi");
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ city: "Berlin", tripled: 66 });
  });

  test("error in one namespace does not break the other", async ({
    request,
    baseURL
  }) => {
    const code = `async () => {
      try {
        await math.divide({ a: 10, b: 0 });
      } catch (e) {
        const sum = await codemode.addNumbers({ a: 1, b: 2 });
        return { caught: e.message, sum: sum.result };
      }
    }`;
    const result = await execute(request, baseURL!, code, "multi");
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      caught: "Division by zero",
      sum: 3
    });
  });
});

// ── positionalArgs ────────────────────────────────────────────────

test.describe("positionalArgs e2e", () => {
  test("tool receives individual positional arguments", async ({
    request,
    baseURL
  }) => {
    const result = await execute(
      request,
      baseURL!,
      'async () => await state.concat("hello", "world")',
      "positional"
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello world");
  });
});

// ── Custom modules ────────────────────────────────────────────────

test.describe("Custom modules e2e", () => {
  test("sandbox can import custom module", async ({ request, baseURL }) => {
    const code = `async () => {
      const { greet, double } = await import("helpers.js");
      return { greeting: greet("world"), doubled: double(21) };
    }`;
    const result = await execute(request, baseURL!, code, "withModules");
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      greeting: "hello world",
      doubled: 42
    });
  });
});

// ── Error handling ────────────────────────────────────────────────

test.describe("Sandbox error handling e2e", () => {
  test("code that throws returns error", async ({ request, baseURL }) => {
    const result = await execute(
      request,
      baseURL!,
      'async () => { throw new Error("boom"); }'
    );
    expect(result.error).toBe("boom");
  });

  test("execution timeout returns error", async ({ request, baseURL }) => {
    // Use async sleep (not sync loop) so the Promise.race timeout can fire
    const result = await execute(
      request,
      baseURL!,
      "async () => { await new Promise(r => setTimeout(r, 30000)); return 'done'; }",
      "timeout"
    );
    expect(result.error).toContain("timed out");
  });

  test("calling non-existent tool returns error", async ({
    request,
    baseURL
  }) => {
    const result = await execute(
      request,
      baseURL!,
      "async () => await codemode.nonexistent({})"
    );
    expect(result.error).toContain("nonexistent");
  });
});

// ── Console capture ───────────────────────────────────────────────

test.describe("Console capture e2e", () => {
  test("console.log output is captured in logs", async ({
    request,
    baseURL
  }) => {
    const result = await execute(
      request,
      baseURL!,
      `async () => {
        console.log("hello from sandbox");
        console.warn("watch out");
        console.error("bad thing");
        return "done";
      }`
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("done");
    expect(result.logs).toContain("hello from sandbox");
    expect(result.logs).toContain("[warn] watch out");
    expect(result.logs).toContain("[error] bad thing");
  });
});

// ── Network isolation ─────────────────────────────────────────────

test.describe("Network isolation e2e", () => {
  test("fetch is blocked in sandbox by default", async ({
    request,
    baseURL
  }) => {
    const result = await execute(
      request,
      baseURL!,
      'async () => { const r = await fetch("https://example.com"); return r.status; }'
    );
    expect(result.error).toBeDefined();
  });
});

// ── Schema validation ─────────────────────────────────────────────

test.describe("Schema validation e2e", () => {
  test("valid input passes schema validation", async ({ request, baseURL }) => {
    const result = await execute(
      request,
      baseURL!,
      "async () => await codemode.strictAdd({ a: 10, b: 20 })",
      "validated"
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ result: 30 });
  });

  test("invalid input is rejected by schema validation", async ({
    request,
    baseURL
  }) => {
    const result = await execute(
      request,
      baseURL!,
      'async () => await codemode.strictAdd({ a: "not-a-number", b: 20 })',
      "validated"
    );
    expect(result.error).toBeDefined();
  });
});

// ── MCP codeMcpServer pipeline ────────────────────────────────────

test.describe("MCP codeMcpServer e2e", () => {
  test("code tool calls upstream MCP tool and returns result", async ({
    request,
    baseURL
  }) => {
    const result = await mcpExecute(
      request,
      baseURL!,
      "async () => await codemode.add({ a: 10, b: 32 })"
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toBe(42);
  });

  test("code tool chains multiple upstream calls", async ({
    request,
    baseURL
  }) => {
    const result = await mcpExecute(
      request,
      baseURL!,
      `async () => {
        const sum = await codemode.add({ a: 5, b: 3 });
        const greeting = await codemode.greet({ name: "Sum is " + sum });
        return greeting;
      }`
    );
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Hello, Sum is 8!");
  });

  test("upstream error surfaces as sandbox exception", async ({
    request,
    baseURL
  }) => {
    const result = await mcpExecute(
      request,
      baseURL!,
      "async () => await codemode.fail_always({})"
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("something went wrong");
  });

  test("upstream error is catchable with try/catch in sandbox", async ({
    request,
    baseURL
  }) => {
    const result = await mcpExecute(
      request,
      baseURL!,
      `async () => {
        try {
          await codemode.fail_always({});
          return "should not reach";
        } catch (e) {
          return "caught: " + e.message;
        }
      }`
    );
    expect(result.isError).toBe(false);
    expect(result.text).toBe("caught: something went wrong");
  });

  test("non-existent tool returns error", async ({ request, baseURL }) => {
    const result = await mcpExecute(
      request,
      baseURL!,
      "async () => await codemode.nope({})"
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("nope");
  });
});
