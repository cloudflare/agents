/**
 * E2E Smoke Tests
 *
 * Basic tests to verify the E2E harness and wrangler dev server are working.
 * These should always pass if the server is running correctly.
 */

import { describe, it, expect } from "vitest";
import { getBaseUrl, uniqueAgentId, agentRequest, getTasks } from "./helpers";

describe("E2E Smoke Tests", () => {
  describe("Server Health", () => {
    it("should have BASE_URL set by setup", () => {
      const baseUrl = getBaseUrl();
      expect(baseUrl).toBeDefined();
      expect(baseUrl).toMatch(/^http/);
    });

    it("should respond to root endpoint", async () => {
      const baseUrl = getBaseUrl();
      const response = await fetch(baseUrl);

      // We expect some response (might be 200, 404, or redirect)
      expect(response.status).toBeDefined();
    });
  });

  describe("Agent Endpoints", () => {
    it("should create agent and return state", async () => {
      const agentId = uniqueAgentId("smoke");
      const response = await agentRequest(agentId, "/state");

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty("sessionId");
      expect(data).toHaveProperty("status");
    });

    it("should have task endpoint accessible", async () => {
      const agentId = uniqueAgentId("smoke");
      const result = await getTasks(agentId);

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty("tasks");
    });

    it("should have chat history endpoint", async () => {
      const agentId = uniqueAgentId("smoke");
      const response = await agentRequest(agentId, "/chat/history");

      expect(response.status).toBe(200);

      const data = (await response.json()) as { messages: unknown[] };
      expect(data).toHaveProperty("messages");
      expect(Array.isArray(data.messages)).toBe(true);
    });
  });

  describe("Agent Isolation", () => {
    it("should have different sessionIds for different agents", async () => {
      const agent1 = uniqueAgentId("iso-1");
      const agent2 = uniqueAgentId("iso-2");

      const [state1, state2] = (await Promise.all([
        agentRequest(agent1, "/state").then((r) => r.json()),
        agentRequest(agent2, "/state").then((r) => r.json())
      ])) as [{ sessionId: string }, { sessionId: string }];

      expect(state1.sessionId).not.toBe(state2.sessionId);
    });
  });
});
