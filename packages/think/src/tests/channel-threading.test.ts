import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

function channelMeta(message: UIMessage | undefined): unknown {
  return (message?.metadata as { channel?: unknown } | undefined)?.channel;
}

describe("channel threading (Phase 4a)", () => {
  it("resolves the channel in wait mode and stamps it on the user message", async () => {
    const agent = await freshAgent("ch-wait");
    await agent.runChannelTurnForTest({ input: "hi", channel: "voice" });

    expect(await agent.getCapturedTurnChannelsForTest()).toContain("voice");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const user = messages.find((m) => m.role === "user");
    expect(channelMeta(user)).toBe("voice");
  });

  it("has no channel context when none is supplied", async () => {
    const agent = await freshAgent("ch-default");
    await agent.runChannelTurnForTest({ input: "hi" });

    const captured = await agent.getCapturedTurnChannelsForTest();
    expect(captured).toContain("");
    expect(captured).not.toContain("voice");
  });

  it("resolves an explicitly named channel", async () => {
    const agent = await freshAgent("ch-web");
    await agent.runChannelTurnForTest({ input: "hi", channel: "web" });
    expect(await agent.getCapturedTurnChannelsForTest()).toContain("web");
  });

  it("re-resolves the channel on continuation from persisted metadata", async () => {
    const agent = await freshAgent("ch-continue");
    await agent.runChannelTurnForTest({ input: "hi", channel: "voice" });
    await agent.resetCapturedTurnChannelsForTest();

    await agent.runChannelTurnForTest({ continuation: true });
    expect(await agent.getCapturedTurnChannelsForTest()).toContain("voice");
  });
});
