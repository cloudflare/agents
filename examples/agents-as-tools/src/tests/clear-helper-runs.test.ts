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

describe("Assistant.clearHelperRuns", () => {
  it("is a no-op on an empty registry", async () => {
    const assistant = await freshAssistant();
    await assistant.clearHelperRuns();
    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });

  it("wipes all rows and helper sub-agents for a mixed-status registry", async () => {
    const assistant = await freshAssistant();

    // Seeding with an `events` array spawns the matching Researcher
    // facet, so after seeding every helper id has a real sub-agent in
    // the registry.
    await assistant.testSeedHelperRun({
      helperId: "running-helper",
      parentToolCallId: "tc-running",
      status: "running",
      events: [
        {
          kind: "started",
          helperId: "running-helper",
          helperType: "Researcher",
          query: "q1"
        }
      ]
    });
    await assistant.testSeedHelperRun({
      helperId: "completed-helper",
      parentToolCallId: "tc-completed",
      status: "completed",
      events: [
        {
          kind: "started",
          helperId: "completed-helper",
          helperType: "Researcher",
          query: "q2"
        },
        { kind: "finished", helperId: "completed-helper", summary: "done." }
      ]
    });
    await assistant.testSeedHelperRun({
      helperId: "errored-helper",
      parentToolCallId: "tc-errored",
      status: "error",
      events: [{ kind: "error", helperId: "errored-helper", error: "boom" }]
    });

    expect(await assistant.hasHelper("running-helper")).toBe(true);
    expect(await assistant.hasHelper("completed-helper")).toBe(true);
    expect(await assistant.hasHelper("errored-helper")).toBe(true);
    expect(await assistant.testReadHelperRuns()).toHaveLength(3);

    await assistant.clearHelperRuns();

    expect(await assistant.testReadHelperRuns()).toEqual([]);
    expect(await assistant.hasHelper("running-helper")).toBe(false);
    expect(await assistant.hasHelper("completed-helper")).toBe(false);
    expect(await assistant.hasHelper("errored-helper")).toBe(false);
  });

  it("is idempotent when called twice", async () => {
    const assistant = await freshAssistant();
    await assistant.testSeedHelperRun({
      helperId: "h",
      parentToolCallId: "tc",
      status: "completed",
      events: [
        {
          kind: "started",
          helperId: "h",
          helperType: "Researcher",
          query: "q"
        },
        { kind: "finished", helperId: "h", summary: "ok" }
      ]
    });

    await assistant.clearHelperRuns();
    // Second call must not throw even though there are no rows and
    // no sub-agents to delete.
    await assistant.clearHelperRuns();

    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });

  it("does not throw if a registry row's sub-agent was already deleted", async () => {
    const assistant = await freshAssistant();

    // Seed a row but no events, so the helper sub-agent was never
    // spawned. `deleteSubAgent` for a name that isn't in the
    // registry is the production failure mode `clearHelperRuns`
    // catches — this test pins it down.
    await assistant.testSeedHelperRun({
      helperId: "ghost",
      parentToolCallId: "tc-ghost",
      status: "interrupted"
    });
    expect(await assistant.hasHelper("ghost")).toBe(false);

    await expect(assistant.clearHelperRuns()).resolves.toBeUndefined();
    expect(await assistant.testReadHelperRuns()).toEqual([]);
  });
});
