import { test, expect } from "@playwright/test";

/**
 * LLM-dependent e2e tests for codemode with Workers AI.
 *
 * These verify the full pipeline including LLM code generation:
 *   user prompt → LLM generates code → createCodeTool → DynamicWorkerExecutor
 *   → sandboxed Worker → tool dispatch via RPC → result → LLM response.
 *
 * Uses Workers AI (@cf/moonshotai/kimi-k2.5) — no API key needed.
 */

async function runChat(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  userMessage: string,
  endpoint = "/run"
): Promise<string> {
  const res = await request.post(`${baseURL}${endpoint}`, {
    headers: { "Content-Type": "application/json" },
    data: {
      messages: [
        {
          id: `msg-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: userMessage }]
        }
      ]
    },
    timeout: 45_000
  });
  expect(res.ok()).toBe(true);
  return res.text();
}

// ── Multi-provider with LLM ───────────────────────────────────────

test.describe("Multi-provider LLM e2e", () => {
  test.setTimeout(45_000);

  test("LLM uses math namespace to multiply numbers", async ({
    request,
    baseURL
  }) => {
    const response = await runChat(
      request,
      baseURL!,
      "What is 6 times 7? Use the codemode tool with the math.multiply function.",
      "/run-multi"
    );

    expect(response).toContain("42");
  });

  test("LLM combines tools from both namespaces", async ({
    request,
    baseURL
  }) => {
    const response = await runChat(
      request,
      baseURL!,
      "First add 10 and 5 using codemode.addNumbers, then multiply the result by 3 using math.multiply. Use the codemode tool to write code that does both.",
      "/run-multi"
    );

    // 10 + 5 = 15, 15 * 3 = 45
    const lower = response.toLowerCase();
    expect(
      lower.includes("45") || lower.includes("15") || lower.includes("multiply")
    ).toBe(true);
  });
});

// ── generateTypes ─────────────────────────────────────────────────

test.describe("generateTypes e2e", () => {
  test.setTimeout(15_000);

  test("multi-provider types include both namespaces", async ({
    request,
    baseURL
  }) => {
    const res = await request.get(`${baseURL}/types/multi`);
    expect(res.ok()).toBe(true);

    const data = await res.json();
    const types = data.types as string;

    expect(types).toContain("declare const codemode");
    expect(types).toContain("declare const math");
    expect(types).toContain("addNumbers");
    expect(types).toContain("getWeather");
    expect(types).toContain("multiply");
    expect(types).toContain("divide");
  });
});
