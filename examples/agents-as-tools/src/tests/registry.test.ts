/**
 * `cf_agent_helper_runs` registry lifecycle.
 *
 * The registry is the parent's state-of-the-world for helper runs:
 *
 *   - `onStart` creates the table and migrates any `running` rows
 *     from a previous (crashed) generation to `interrupted`. This is
 *     what stops a "Running…" panel hanging in the UI forever after
 *     the parent restarts mid-helper.
 *   - `runResearchHelper` inserts a row at `running` with `helper_type`
 *     and `query`, and updates it to `completed` (with `summary`) or
 *     `error` (with `error_message`) as the helper terminates.
 *   - `clearHelperRuns` wipes the table.
 *
 * These tests pin down the schema shape and the `onStart`
 * interrupted-sweep semantics. The full happy-path insert is covered
 * indirectly by `helper-stream.test.ts`.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueAssistantName } from "./helpers";
import type { Assistant } from "./worker";

async function freshAssistant(): Promise<{
  assistant: DurableObjectStub<Assistant>;
  name: string;
}> {
  const name = uniqueAssistantName();
  const assistant = await getAgentByName(env.Assistant, name);
  return { assistant, name };
}

describe("Assistant — cf_agent_helper_runs schema", () => {
  it("starts with no helper runs", async () => {
    const { assistant } = await freshAssistant();
    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });

  it("seeded rows are visible via testReadHelperRuns with full metadata", async () => {
    const { assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h1",
      parentToolCallId: "tc-1",
      helperType: "Researcher",
      query: "what changed in HTTP/3?",
      status: "running",
      startedAt: 100
    });
    await assistant.testSeedHelperRun({
      helperId: "h2",
      parentToolCallId: "tc-2",
      helperType: "Researcher",
      query: "OAuth vs OIDC differences",
      status: "completed",
      summary: "OAuth is for authorization, OIDC for identity.",
      startedAt: 200,
      completedAt: 250
    });

    const rows = await assistant.testReadHelperRuns();
    expect(rows).toEqual([
      {
        helper_id: "h1",
        parent_tool_call_id: "tc-1",
        helper_type: "Researcher",
        query: "what changed in HTTP/3?",
        status: "running",
        summary: null,
        error_message: null,
        started_at: 100,
        completed_at: null
      },
      {
        helper_id: "h2",
        parent_tool_call_id: "tc-2",
        helper_type: "Researcher",
        query: "OAuth vs OIDC differences",
        status: "completed",
        summary: "OAuth is for authorization, OIDC for identity.",
        error_message: null,
        started_at: 200,
        completed_at: 250
      }
    ]);
  });

  it("error rows carry error_message", async () => {
    const { assistant } = await freshAssistant();
    await assistant.testSeedHelperRun({
      helperId: "h-err",
      parentToolCallId: "tc-err",
      status: "error",
      errorMessage: "model returned 500"
    });
    const rows = await assistant.testReadHelperRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].error_message).toBe("model returned 500");
    expect(rows[0].summary).toBeNull();
  });
});

describe("Assistant — onStart interrupted sweep", () => {
  it("rewrites running → interrupted on restart", async () => {
    const { assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "still-running",
      parentToolCallId: "tc-running",
      status: "running",
      startedAt: 1
    });

    // Simulate parent wake. In production this runs once when the DO
    // hibernates and is reconstructed; the test calls it directly so
    // it doesn't have to drive an actual eviction cycle.
    await assistant.testRerunOnStart();

    const rows = await assistant.testReadHelperRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("interrupted");
    expect(rows[0].completed_at).toBeGreaterThan(0);
  });

  it("leaves completed/error/interrupted rows untouched", async () => {
    const { assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "done",
      parentToolCallId: "tc-done",
      status: "completed",
      summary: "done summary",
      startedAt: 1,
      completedAt: 10
    });
    await assistant.testSeedHelperRun({
      helperId: "errored",
      parentToolCallId: "tc-err",
      status: "error",
      errorMessage: "boom",
      startedAt: 2,
      completedAt: 20
    });
    await assistant.testSeedHelperRun({
      helperId: "old-interrupt",
      parentToolCallId: "tc-int",
      status: "interrupted",
      startedAt: 3,
      completedAt: 30
    });

    await assistant.testRerunOnStart();

    const rows = await assistant.testReadHelperRuns();
    const byId = Object.fromEntries(rows.map((r) => [r.helper_id, r]));
    expect(byId["done"].status).toBe("completed");
    expect(byId["done"].completed_at).toBe(10);
    expect(byId["done"].summary).toBe("done summary");
    expect(byId["errored"].status).toBe("error");
    expect(byId["errored"].completed_at).toBe(20);
    expect(byId["errored"].error_message).toBe("boom");
    expect(byId["old-interrupt"].status).toBe("interrupted");
    expect(byId["old-interrupt"].completed_at).toBe(30);
  });

  it("only touches rows with status='running'", async () => {
    const { assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "a",
      parentToolCallId: "tc-a",
      status: "running",
      startedAt: 1
    });
    await assistant.testSeedHelperRun({
      helperId: "b",
      parentToolCallId: "tc-b",
      status: "completed",
      summary: "ok",
      startedAt: 2,
      completedAt: 5
    });

    await assistant.testRerunOnStart();

    const rows = await assistant.testReadHelperRuns();
    const byId = Object.fromEntries(rows.map((r) => [r.helper_id, r]));
    expect(byId["a"].status).toBe("interrupted");
    expect(byId["b"].status).toBe("completed");
  });

  it("is idempotent: a second restart does not re-stamp completed_at", async () => {
    const { assistant } = await freshAssistant();
    await assistant.testSeedHelperRun({
      helperId: "x",
      parentToolCallId: "tc-x",
      status: "running",
      startedAt: 1
    });
    await assistant.testRerunOnStart();
    const firstSweep = await assistant.testReadHelperRuns();
    const stampedAt = firstSweep[0].completed_at;

    // Wait long enough that a second sweep, if it ran, would write a
    // larger Date.now().
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assistant.testRerunOnStart();

    const secondSweep = await assistant.testReadHelperRuns();
    expect(secondSweep[0].status).toBe("interrupted");
    // Completed_at must not move — the row is no longer 'running'.
    expect(secondSweep[0].completed_at).toBe(stampedAt);
  });
});
