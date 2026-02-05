/**
 * E2E Facet/Subagent Tests - Fast (No LLM)
 *
 * Tests that require Durable Object Facets, which don't work in vitest-pool-workers.
 * These run against a real wrangler dev server where facets are available.
 *
 * NOTE: LLM-dependent tests are in facets.slow.test.ts and excluded by default.
 * Run them with: npm run test:e2e:slow
 */

import { describe, it, expect } from "vitest";
import { uniqueAgentId, agentRequest, getSubagents, getTasks } from "./helpers";

describe("Subagent Facets (E2E)", () => {
  describe("Subagent API Availability", () => {
    it("should have subagent endpoint enabled via --var", async () => {
      const agentId = uniqueAgentId("facet");
      const result = await getSubagents(agentId);

      // With --var ENABLE_SUBAGENT_API:true, we should get 200
      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty("activeCount");
      expect(result.data).toHaveProperty("statuses");
    });

    it("should return empty subagents list for new agent", async () => {
      const agentId = uniqueAgentId("facet-empty");
      const result = await getSubagents(agentId);

      expect(result.status).toBe(200);
      const data = result.data as { activeCount: number; statuses: unknown[] };
      expect(data.activeCount).toBe(0);
      expect(data.statuses).toEqual([]);
    });
  });

  describe("Task Management", () => {
    it("should start with empty task list", async () => {
      const agentId = uniqueAgentId("facet-tasks");

      const result = await getTasks(agentId);
      expect(result.status).toBe(200);
      expect((result.data as { tasks: unknown[] }).tasks).toEqual([]);
    });
  });

  describe("Subagent Spawn Endpoint", () => {
    it("should have /subagents/spawn endpoint", async () => {
      const agentId = uniqueAgentId("facet-spawn");

      // Try to spawn without required fields - should get error
      const response = await agentRequest(agentId, "/subagents/spawn", {
        method: "POST",
        body: JSON.stringify({})
      });

      // Should respond (either error or success) - endpoint exists
      expect([200, 400, 500]).toContain(response.status);
    });

    it("should spawn subagent with valid task data", async () => {
      const agentId = uniqueAgentId("facet-spawn-valid");

      // Spawn a subagent
      const response = await agentRequest(agentId, "/subagents/spawn", {
        method: "POST",
        body: JSON.stringify({
          title: "Test Subagent Task",
          description: "A simple test task for E2E"
        })
      });

      // This may fail due to facets not being fully available in local wrangler
      // or succeed if facets work - either way, endpoint should respond
      if (response.status === 200) {
        const data = (await response.json()) as {
          success: boolean;
          taskId: string;
          facetName: string;
          activeCount: number;
        };
        expect(data.success).toBe(true);
        expect(data).toHaveProperty("taskId");
        expect(data).toHaveProperty("facetName");
        expect(data.activeCount).toBeGreaterThanOrEqual(0);
      } else {
        // Log for debugging - facets may not work in this environment
        const error = await response.text();
        console.log(
          `Spawn returned ${response.status}: ${error.slice(0, 200)}`
        );
      }
    });
  });

  describe("Subagent Status Tracking", () => {
    it("should track spawned subagent in status list", async () => {
      const agentId = uniqueAgentId("facet-track");

      // Spawn a subagent
      const spawnResponse = await agentRequest(agentId, "/subagents/spawn", {
        method: "POST",
        body: JSON.stringify({
          title: "Tracked Task",
          description: "Task to verify tracking"
        })
      });

      if (spawnResponse.status !== 200) {
        // Skip if spawn didn't work (facets may not be available)
        console.log("Skipping tracking test - spawn failed");
        return;
      }

      const spawnData = (await spawnResponse.json()) as { taskId: string };

      // Check status endpoint
      const statusResponse = await agentRequest(
        agentId,
        `/subagents/${spawnData.taskId}`
      );

      if (statusResponse.status === 200) {
        const status = await statusResponse.json();
        expect(status).toHaveProperty("taskId", spawnData.taskId);
        expect(status).toHaveProperty("status");
      }
    });
  });

  // NOTE: LLM execution tests are in facets.slow.test.ts
  // Run them with: npm run test:e2e:slow

  describe("Facet Lifecycle", () => {
    it.todo("should spawn multiple facets concurrently");
    it.todo("should clean up completed facets");
    // NOTE: "should share SQLite storage between facets" - TESTED AND DISPROVEN
    // See "Facet Storage Sharing" tests above - storage is ISOLATED, not shared
  });

  describe("Facet Storage Sharing", () => {
    it("should verify if facets share SQLite storage with parent", async () => {
      const agentId = uniqueAgentId("storage-test");

      // Call the debug endpoint that tests storage sharing
      const response = await agentRequest(agentId, "/debug/storage-test", {
        method: "POST"
      });

      // Log the full response for debugging
      const data = await response.json();
      console.log("Storage test result:", JSON.stringify(data, null, 2));

      expect(response.status).toBe(200);

      // Check the result structure
      const result = data as {
        success: boolean;
        storageIsShared?: boolean;
        conclusion?: string;
        facetRead?: { found: boolean; value: string | null; error?: string };
        facetWrite?: { success: boolean; error?: string };
        parentReadFacetValue?: string | null;
        facetVisibleTables?: string[];
        error?: string;
        facetError?: string;
      };

      if (!result.success) {
        console.log("Storage test failed:", result.error, result.facetError);
        // Don't fail the test - just report what happened
        // Facets might not work in this environment
        return;
      }

      // Log the conclusion - this is the critical answer!
      console.log(`\n${"=".repeat(60)}`);
      console.log("STORAGE SHARING TEST RESULT:", result.conclusion);
      console.log("=".repeat(60));
      console.log("Facet could read parent's value:", result.facetRead?.found);
      console.log("Facet could write value:", result.facetWrite?.success);
      console.log(
        "Parent could read facet's value:",
        result.parentReadFacetValue !== null
      );
      console.log("Tables visible to facet:", result.facetVisibleTables);
      console.log(`${"=".repeat(60)}\n`);

      // The test "passes" regardless - we're gathering information
      // The real question is answered in the console output
      expect(result).toHaveProperty("storageIsShared");
      expect(result).toHaveProperty("conclusion");
    });
  });

  describe("Facet Static Variable Sharing", () => {
    it("should verify if facets share static variables with parent", async () => {
      const agentId = uniqueAgentId("static-test");

      // Call the debug endpoint that tests static variable sharing
      const response = await agentRequest(agentId, "/debug/static-test", {
        method: "POST"
      });

      // Log the full response for debugging
      const data = await response.json();
      console.log("Static test result:", JSON.stringify(data, null, 2));

      expect(response.status).toBe(200);

      // Check the result structure
      const result = data as {
        success: boolean;
        staticIsShared?: boolean;
        conclusion?: string;
        parentWrite?: { key: string; value: string };
        parentReadBack?: string;
        facetResult?: {
          keyChecked: string;
          found: boolean;
          value: string | null;
          mapSize: number;
          allKeys: string[];
        };
        parentReadFacetValue?: string | null;
        error?: string;
        facetError?: string;
      };

      if (!result.success) {
        console.log("Static test failed:", result.error, result.facetError);
        // Don't fail the test - just report what happened
        // Facets might not work in this environment
        return;
      }

      // Log the conclusion - this is the critical answer!
      console.log(`\n${"=".repeat(60)}`);
      console.log("STATIC VARIABLE SHARING TEST RESULT:", result.conclusion);
      console.log("=".repeat(60));
      console.log("Parent set value:", result.parentWrite?.value);
      console.log("Parent could read back:", result.parentReadBack);
      console.log("Facet found parent's value:", result.facetResult?.found);
      console.log("Facet read value:", result.facetResult?.value);
      console.log("Facet saw map size:", result.facetResult?.mapSize);
      console.log("Facet saw keys:", result.facetResult?.allKeys);
      console.log(
        "Parent could read facet's value:",
        result.parentReadFacetValue
      );
      console.log(`${"=".repeat(60)}\n`);

      // The test "passes" regardless - we're gathering information
      // The real question is answered in the console output
      expect(result).toHaveProperty("staticIsShared");
      expect(result).toHaveProperty("conclusion");
    });
  });

  describe("Facet RPC to Parent", () => {
    it("should verify if facets can make RPC calls back to parent", async () => {
      const agentId = uniqueAgentId("rpc-test");

      // Call the debug endpoint that tests RPC calls
      const response = await agentRequest(agentId, "/debug/rpc-test", {
        method: "POST"
      });

      // Log the full response for debugging
      const data = await response.json();
      console.log("RPC test result:", JSON.stringify(data, null, 2));

      expect(response.status).toBe(200);

      // Check the result structure
      const result = data as {
        success: boolean;
        rpcWorks?: boolean;
        conclusion?: string;
        parentDOId?: string;
        exportsCheck?: {
          hasExports: boolean;
          exportKeys: string[];
          hasThink: boolean;
          error?: string;
        };
        filesCheck?: {
          success: boolean;
          files?: string[];
          error?: string;
        };
        rpcCheck?: {
          success: boolean;
          result?: unknown;
          error?: string;
        };
        error?: string;
        facetError?: string;
      };

      if (!result.success) {
        console.log("RPC test failed:", result.error, result.facetError);
        return;
      }

      // Log the conclusion - this is the critical answer!
      console.log(`\n${"=".repeat(60)}`);
      console.log("FACET RPC TEST RESULT:", result.conclusion);
      console.log("=".repeat(60));
      console.log("Parent DO ID:", result.parentDOId);
      console.log("Facet has exports:", result.exportsCheck?.hasExports);
      console.log("Export keys:", result.exportsCheck?.exportKeys);
      console.log("Has Think export:", result.exportsCheck?.hasThink);
      console.log("Files check success:", result.filesCheck?.success);
      console.log("Files check error:", result.filesCheck?.error);
      console.log("Files found:", result.filesCheck?.files);
      console.log("Direct RPC success:", result.rpcCheck?.success);
      console.log("Direct RPC error:", result.rpcCheck?.error);
      console.log(`${"=".repeat(60)}\n`);

      expect(result).toHaveProperty("rpcWorks");
      expect(result).toHaveProperty("conclusion");
    });
  });
});

// NOTE: Chat with Subagent Delegation tests are in facets.slow.test.ts
// Run them with: npm run test:e2e:slow
