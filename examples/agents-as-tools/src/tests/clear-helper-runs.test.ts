/**
 * `Assistant.clearHelperRuns` callable.
 *
 * Wipes the registry **and** deletes every helper sub-agent. Called
 * by the UI's "Clear" button before `clearHistory()` so that, after
 * the chat is cleared, no helper timeline can replay in any other
 * tab on the next reconnect.
 *
 * Tests pin down the lifecycle:
 *
 *   - empty registry → no-op
 *   - mixed-status registry → all rows wiped, all sub-agents gone
 *   - missing helper sub-agent → `clearHelperRuns` doesn't throw
 *     (idempotent best-effort cleanup; matches the production
 *     comment in `clearHelperRuns`)
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueAssistantName } from "./helpers";
import type { Assistant } from "./worker";

async function freshAssistant(): Promise<DurableObjectStub<Assistant>> {
  const name = uniqueAssistantName();
  return getAgentByName(env.Assistant, name);
}

const SAMPLE_TEXT_CHUNK = JSON.stringify({
  type: "text-delta",
  id: "t-1",
  delta: "hello"
});

describe("Assistant.clearHelperRuns", () => {
  it("is a no-op on an empty registry", async () => {
    const assistant = await freshAssistant();
    await assistant.clearHelperRuns();
    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });

  it("wipes all rows and helper sub-agents for a mixed-status registry", async () => {
    const assistant = await freshAssistant();

    // Seeding with a `chunks` array spawns the matching Researcher
    // facet, so after seeding every helper id has a real sub-agent in
    // the registry.
    await assistant.testSeedHelperRun({
      helperId: "running-helper",
      parentToolCallId: "tc-running",
      status: "running",
      query: "q1",
      chunks: [SAMPLE_TEXT_CHUNK]
    });
    await assistant.testSeedHelperRun({
      helperId: "completed-helper",
      parentToolCallId: "tc-completed",
      status: "completed",
      query: "q2",
      summary: "all done",
      chunks: [SAMPLE_TEXT_CHUNK]
    });
    await assistant.testSeedHelperRun({
      helperId: "errored-helper",
      parentToolCallId: "tc-errored",
      status: "error",
      query: "q3",
      errorMessage: "boom",
      chunks: [SAMPLE_TEXT_CHUNK]
    });

    expect(await assistant.hasHelper("running-helper", "Researcher")).toBe(
      true
    );
    expect(await assistant.hasHelper("completed-helper", "Researcher")).toBe(
      true
    );
    expect(await assistant.hasHelper("errored-helper", "Researcher")).toBe(
      true
    );
    expect(await assistant.testReadHelperRuns()).toHaveLength(3);

    await assistant.clearHelperRuns();

    expect(await assistant.testReadHelperRuns()).toEqual([]);
    expect(await assistant.hasHelper("running-helper", "Researcher")).toBe(
      false
    );
    expect(await assistant.hasHelper("completed-helper", "Researcher")).toBe(
      false
    );
    expect(await assistant.hasHelper("errored-helper", "Researcher")).toBe(
      false
    );
  });

  it("is idempotent when called twice", async () => {
    const assistant = await freshAssistant();
    await assistant.testSeedHelperRun({
      helperId: "h",
      parentToolCallId: "tc",
      status: "completed",
      summary: "ok",
      chunks: [SAMPLE_TEXT_CHUNK]
    });

    await assistant.clearHelperRuns();
    // Second call must not throw even though there are no rows and
    // no sub-agents to delete.
    await assistant.clearHelperRuns();

    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });

  it("does not throw if a registry row's sub-agent was already deleted", async () => {
    const assistant = await freshAssistant();

    // Seed a row but no chunks, so the helper sub-agent was never
    // spawned. `deleteSubAgent` for a name that isn't in the
    // registry is the production failure mode `clearHelperRuns`
    // catches — this test pins it down.
    await assistant.testSeedHelperRun({
      helperId: "ghost",
      parentToolCallId: "tc-ghost",
      status: "interrupted"
    });
    expect(await assistant.hasHelper("ghost", "Researcher")).toBe(false);

    await expect(assistant.clearHelperRuns()).resolves.toBeUndefined();
    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });

  it("clears a mixed-class registry (Researcher + Planner) via the right facet table for each", async () => {
    const assistant = await freshAssistant();

    // Seed one row of each class. `helperType` drives BOTH the
    // row's `helper_type` column AND the facet the chunks get
    // written into — so `Planner` rows go into the Planner DO,
    // not the Researcher DO. `clearHelperRuns` then has to look
    // up the right class via the production registry to delete
    // each facet correctly; if the lookup were hardcoded to
    // Researcher (the v0.2 behavior) the Planner facet would leak.
    await assistant.testSeedHelperRun({
      helperId: "researcher-row",
      parentToolCallId: "tc-r",
      helperType: "Researcher",
      status: "completed",
      summary: "research result",
      chunks: [SAMPLE_TEXT_CHUNK]
    });
    await assistant.testSeedHelperRun({
      helperId: "planner-row",
      parentToolCallId: "tc-p",
      helperType: "Planner",
      status: "completed",
      summary: "plan result",
      chunks: [SAMPLE_TEXT_CHUNK]
    });

    expect(await assistant.hasHelper("researcher-row", "Researcher")).toBe(
      true
    );
    expect(await assistant.hasHelper("planner-row", "Planner")).toBe(true);
    expect(await assistant.testReadHelperRuns()).toHaveLength(2);

    await assistant.clearHelperRuns();

    expect(await assistant.testReadHelperRuns()).toEqual([]);
    expect(await assistant.hasHelper("researcher-row", "Researcher")).toBe(
      false
    );
    expect(await assistant.hasHelper("planner-row", "Planner")).toBe(false);
  });
});
