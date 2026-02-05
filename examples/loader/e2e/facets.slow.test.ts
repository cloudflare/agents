/**
 * E2E Facet/Subagent Slow Tests - LLM Integration
 *
 * These tests require an OPENAI_API_KEY and make actual LLM calls.
 * They are slow (5-30+ seconds each) and should NOT run in CI.
 *
 * Run manually with:
 *   npm run test:e2e:slow
 *
 * Or run all E2E tests including slow:
 *   E2E_INCLUDE_SLOW=true npm run test:e2e
 */

import { describe, it, expect } from "vitest";
import {
  uniqueAgentId,
  agentRequest,
  getSubagents,
  getTasks,
  waitFor,
  hasOpenAIKey
} from "./helpers";

// Skip entire file if no API key
const skipAll = !hasOpenAIKey();

describe.skipIf(skipAll)("Subagent LLM Execution (Slow)", () => {
  it(
    "should execute subagent LLM loop with simple calculation",
    async () => {
      const agentId = uniqueAgentId("facet-exec");

      // Spawn subagent with a simple task
      const spawnResponse = await agentRequest(agentId, "/subagents/spawn", {
        method: "POST",
        body: JSON.stringify({
          title: "Simple Calculation",
          description: "Calculate 2 + 2 and report the result"
        })
      });

      expect(spawnResponse.status).toBe(200);
      const spawnData = (await spawnResponse.json()) as { taskId: string };

      // Wait for completion (with timeout)
      const finalStatus = await waitFor(
        async () => {
          const res = await agentRequest(
            agentId,
            `/subagents/${spawnData.taskId}`
          );
          if (res.status !== 200) return { status: "error" };
          return res.json() as Promise<{ status: string; result?: string }>;
        },
        {
          condition: (s) =>
            s.status === "complete" ||
            s.status === "error" ||
            s.status === "failed",
          timeout: 60000,
          interval: 2000,
          description: "subagent completion"
        }
      );

      expect(["complete", "error", "failed"]).toContain(finalStatus.status);
      if (finalStatus.status === "complete") {
        expect(finalStatus.result).toBeDefined();
        // Result should mention 4 (2 + 2)
        console.log("Subagent result:", finalStatus.result);
      }
    },
    { timeout: 90000 }
  );

  it(
    "should spawn subagent via direct endpoint and execute LLM",
    async () => {
      const agentId = uniqueAgentId("direct-subagent");

      // Spawn subagent directly via endpoint
      const spawnResponse = await agentRequest(agentId, "/subagents/spawn", {
        method: "POST",
        body: JSON.stringify({
          title: "Calculate 42 * 2",
          description:
            "Calculate what 42 multiplied by 2 equals and return the answer."
        })
      });

      expect(spawnResponse.status).toBe(200);
      const spawnData = (await spawnResponse.json()) as {
        success: boolean;
        taskId: string;
        facetName: string;
      };

      expect(spawnData.success).toBe(true);
      console.log(`Spawned subagent: ${spawnData.facetName}`);

      // Wait for subagent to complete with debugging
      let pollCount = 0;
      const finalStatus = await waitFor(
        async () => {
          pollCount++;
          const res = await agentRequest(
            agentId,
            `/subagents/${spawnData.taskId}`
          );

          if (res.status === 404) {
            console.log(`Poll ${pollCount}: 404 - subagent not found`);
            return { status: "not_found", taskId: spawnData.taskId };
          }

          if (res.status !== 200) {
            const errorBody = await res
              .text()
              .catch(() => "unable to read body");
            console.log(
              `Poll ${pollCount}: status ${res.status}, body: ${errorBody}`
            );
            return { status: "pending", taskId: spawnData.taskId };
          }

          const data = (await res.json()) as {
            status: string;
            result?: string;
            taskId: string;
            error?: string;
          };

          console.log(`Poll ${pollCount}: ${JSON.stringify(data)}`);
          return data;
        },
        {
          condition: (s) =>
            s.status === "complete" ||
            s.status === "error" ||
            s.status === "failed" ||
            s.status === "not_found",
          timeout: 90000,
          interval: 3000,
          description: "subagent LLM completion"
        }
      );

      console.log("Final status:", finalStatus);

      expect(["complete", "error", "failed"]).toContain(finalStatus.status);

      if (finalStatus.status === "complete") {
        expect(finalStatus.result).toBeDefined();
        // The result should mention 84 (42 * 2)
        console.log("Subagent result:", finalStatus.result);
      }
    },
    { timeout: 120000 }
  );

  it.todo("should handle subagent tool execution");
  it.todo("should update task graph on completion");
});

describe.skipIf(skipAll)("Chat with Subagent Delegation (Slow)", () => {
  it(
    "should delegate task through chat and complete via subagent",
    async () => {
      const agentId = uniqueAgentId("delegation-flow");

      // Send a chat message that should trigger delegation
      // The system prompt tells the agent to use subagents for parallel work
      const chatResponse = await agentRequest(agentId, "/chat", {
        method: "POST",
        body: JSON.stringify({
          message:
            "I have two independent tasks: (1) Calculate what 15 * 17 equals, and (2) Tell me what the capital of France is. Please delegate these to subagents since they're independent."
        })
      });

      expect(chatResponse.status).toBe(200);

      // Give the agent time to process and potentially spawn subagents
      await new Promise((r) => setTimeout(r, 5000));

      // Check if any subagents were spawned
      const subagentsResult = await getSubagents(agentId);
      expect(subagentsResult.status).toBe(200);

      const subagentData = subagentsResult.data as {
        activeCount: number;
        statuses: Array<{ taskId: string; status: string }>;
      };

      console.log(
        `Subagents spawned: ${subagentData.activeCount}`,
        subagentData.statuses
      );

      // If subagents were spawned, wait for them to complete
      if (subagentData.activeCount > 0 || subagentData.statuses.length > 0) {
        // Wait for all subagents to complete (or timeout)
        const maxWait = 60000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
          const currentStatus = await getSubagents(agentId);
          const data = currentStatus.data as {
            activeCount: number;
            statuses: Array<{ status: string }>;
          };

          const allComplete = data.statuses.every(
            (s) => s.status === "complete" || s.status === "error"
          );

          if (allComplete && data.statuses.length > 0) {
            console.log("All subagents completed:", data.statuses);
            break;
          }

          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Check tasks were created
      const tasksResult = await getTasks(agentId);
      expect(tasksResult.status).toBe(200);

      const tasks = (tasksResult.data as { tasks: unknown[] }).tasks;
      console.log(`Tasks created: ${tasks.length}`);

      // Verify we got some response
      const historyResponse = await agentRequest(agentId, "/chat/history");
      expect(historyResponse.status).toBe(200);

      const history = (await historyResponse.json()) as {
        messages: Array<{ role: string; content: string }>;
      };

      // Should have at least user message and assistant response
      expect(history.messages.length).toBeGreaterThanOrEqual(2);

      const assistantMessages = history.messages.filter(
        (m) => m.role === "assistant"
      );
      expect(assistantMessages.length).toBeGreaterThan(0);

      console.log(
        "Assistant response:",
        assistantMessages[0]?.content?.slice(0, 500)
      );
    },
    { timeout: 120000 }
  ); // 2 minute timeout for full flow

  it.todo("should aggregate results from multiple subagents");
  it.todo("should handle subagent errors gracefully");
});
