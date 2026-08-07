import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentByName: vi.fn()
}));

vi.mock("agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("agents")>()),
  getAgentByName: mocks.getAgentByName
}));

import worker from "../src/server";

const env = {
  API_TOKEN: "test-token",
  RlmThinkAgent: {},
  BasicThinkAgent: {},
  MODEL: "test-model",
  REASONING_EFFORT: "high",
  MAX_STEPS: "41",
  TURN_TIMEOUT_MS: "9999",
  MAX_RLM_DEPTH: "0",
  MAX_RLM_CALLS: "17"
} as unknown as Env;

function request(path: string, method = "GET", json?: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.API_TOKEN}`,
      ...(json === undefined ? {} : { "content-type": "application/json" })
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) })
  });
}

describe("RLM eval diagnostics", () => {
  beforeEach(() => {
    mocks.getAgentByName.mockReset();
    vi.unstubAllEnvs();
  });

  it("returns only the effective non-secret runtime configuration", async () => {
    const response = await worker.fetch(request("/eval/config"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      model: "test-model",
      reasoningEffort: "high",
      maxSteps: 40,
      timeoutMs: 10_000,
      maxDepth: 0,
      maxRlmCalls: 16
    });
    expect(mocks.getAgentByName).not.toHaveBeenCalled();
  });

  it("hides local evaluation routes outside development", async () => {
    vi.stubEnv("DEV", false);

    const response = await worker.fetch(request("/eval/config"), env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "route not found"
    });
    expect(mocks.getAgentByName).not.toHaveBeenCalled();
  });

  it("returns count-only diagnostics for the named RLM session", async () => {
    const messages = [{ id: "message-1", role: "user", content: "hello" }];
    const getMessages = vi.fn(async () => messages);
    mocks.getAgentByName.mockResolvedValue({ getMessages });

    const response = await worker.fetch(request("/eval/rlm/arc%20trial"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      diagnostics: {
        messageCount: 1,
        assistantMessageCount: 0,
        modelStepCount: 0,
        toolCallCount: 0,
        toolNames: []
      }
    });
    expect(mocks.getAgentByName).toHaveBeenCalledWith(
      env.RlmThinkAgent,
      "arc trial"
    );
    expect(getMessages).toHaveBeenCalledOnce();
  });

  it("does not resolve an RLM agent for non-GET requests", async () => {
    const response = await worker.fetch(
      request("/eval/rlm/arc-trial", "POST"),
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "route not found"
    });
    expect(mocks.getAgentByName).not.toHaveBeenCalled();
  });
});

describe("basic Think eval route", () => {
  beforeEach(() => {
    mocks.getAgentByName.mockReset();
  });

  it("runs one isolated baseline evaluation", async () => {
    const evaluate = vi.fn(async () => ({
      status: "completed",
      answer: '{"ok":true}'
    }));
    mocks.getAgentByName.mockResolvedValue({ evaluate });

    const payload = { task: "return JSON", context: "material" };
    const response = await worker.fetch(
      request("/eval/baselines/trial-1", "POST", payload),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "completed",
      answer: '{"ok":true}'
    });
    expect(mocks.getAgentByName).toHaveBeenCalledWith(
      env.BasicThinkAgent,
      "trial-1"
    );
    expect(evaluate).toHaveBeenCalledWith(payload);
  });

  it("does not resolve a baseline agent for unsupported methods", async () => {
    const response = await worker.fetch(
      request("/eval/baselines/trial-1", "DELETE"),
      env
    );

    expect(response.status).toBe(404);
    expect(mocks.getAgentByName).not.toHaveBeenCalled();
  });
});
