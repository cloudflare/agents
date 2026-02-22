import { test, expect } from "@playwright/test";

/**
 * E2E tests for @cloudflare/codemode with a real AI binding.
 *
 * These verify the full pipeline:
 *   user prompt → LLM generates code via createCodeTool → DynamicWorkerExecutor
 *   runs the code in an isolated Worker → tool functions called via RPC → result returned.
 *
 * Uses Workers AI (@cf/zai-org/glm-4.7-flash) — no API key needed.
 */

async function runChat(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  userMessage: string
): Promise<string> {
  const res = await request.post(`${baseURL}/run`, {
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

test.describe("codemode e2e (Workers AI)", () => {
  test.setTimeout(45_000);

  test("LLM generates and executes code that calls addNumbers tool", async ({
    request,
    baseURL
  }) => {
    const response = await runChat(
      request,
      baseURL!,
      "What is 17 + 25? Use the codemode tool with the addNumbers function to calculate this."
    );

    // The response stream should contain the answer 42 somewhere
    // (either in the tool result or the LLM's text response)
    expect(response).toContain("42");
  });

  test("LLM generates and executes code that calls getWeather tool", async ({
    request,
    baseURL
  }) => {
    const response = await runChat(
      request,
      baseURL!,
      "What is the weather in London? Use the codemode tool with the getWeather function."
    );

    // The getWeather tool returns { city: "London", temperature: 22, condition: "Sunny" }
    // The LLM should mention London or the weather data in its response
    const lower = response.toLowerCase();
    expect(
      lower.includes("london") ||
        lower.includes("22") ||
        lower.includes("sunny")
    ).toBe(true);
  });

  test("LLM generates and executes code that calls listProjects tool", async ({
    request,
    baseURL
  }) => {
    const response = await runChat(
      request,
      baseURL!,
      "List all projects using the codemode tool with the listProjects function."
    );

    // listProjects returns Alpha and Beta
    const lower = response.toLowerCase();
    expect(lower.includes("alpha") || lower.includes("beta")).toBe(true);
  });

  test("LLM generates code with multiple tool calls", async ({
    request,
    baseURL
  }) => {
    const response = await runChat(
      request,
      baseURL!,
      "Using the codemode tool, first get the weather in Paris, then add the numbers 10 and 5. Return both results."
    );

    // Should contain evidence of both tool calls completing
    const lower = response.toLowerCase();
    expect(
      lower.includes("paris") ||
        lower.includes("22") ||
        lower.includes("15") ||
        lower.includes("sunny")
    ).toBe(true);
  });

  test("generateTypes returns valid type definitions", async ({
    request,
    baseURL
  }) => {
    const res = await request.get(`${baseURL}/types`);
    expect(res.ok()).toBe(true);

    const data = await res.json();
    const types = data.types as string;

    expect(types).toContain("declare const codemode");
    expect(types).toContain("addNumbers");
    expect(types).toContain("getWeather");
    expect(types).toContain("createProject");
    expect(types).toContain("listProjects");
  });
});
