/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/channel-policy.test.ts
 * - last original change: unknown
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `partyserver` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 */
import { env } from "cloudflare:workers";
import { getServerByName } from "./compat.js";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./fixtures/index.js";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

describe("per-channel policy (Phase 4b)", () => {
  it("prepends channel instructions to the system prompt before beforeTurn", async () => {
    const agent = await freshAgent("policy-instructions");
    await agent.runChannelTurnForTest({ input: "hi", channel: "voice" });
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.system).toContain("VOICE MODE");
  });

  it("narrows the tool set via the channel policy (removes, not just adds)", async () => {
    const agent = await freshAgent("policy-tools");
    await agent.runChannelTurnForTest({ input: "hi", channel: "voice" });
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.toolNames).toEqual([]);
  });

  it("does not apply channel policy for turns on other channels", async () => {
    const agent = await freshAgent("policy-other");
    await agent.runChannelTurnForTest({ input: "hi", channel: "web" });
    const log = await agent.getBeforeTurnLog();
    expect(log[log.length - 1]?.system).not.toContain("VOICE MODE");
  });
});
