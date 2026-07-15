/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/turn-metadata.test.ts
 * - last original change: 7e0c0692
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `partyserver` and fixture imports to the ported compat shim /
 *   shared fixture index.
 * - Source supplied verbatim by the orchestrator because this worktree is
 *   pinned before the original file landed upstream.
 */
// @ts-nocheck
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { getServerByName } from "./compat.js";
import type { ThinkSessionThinkTestAgent as ThinkTestAgent } from "./fixtures/index.js";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkSessionThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

/**
 * `ChatOptions.metadata`: server-supplied per-turn metadata is stamped on the
 * turn's user message (alongside `channel`), readable turn-scoped via
 * `activeTurnMetadata`, re-resolvable from durable history (recovery), and
 * NEVER forgeable through client-supplied message metadata.
 */
describe("turn metadata", () => {
  it("stamps chat() metadata on the user message and exposes it during the turn", async () => {
    const agent = await freshAgent(`turn-meta-chat-${crypto.randomUUID()}`);

    await agent.runChatTurnForTest({
      input: "hello",
      channel: "voice",
      metadata: { actingUserId: "user-123", origin: "slack" }
    });

    // Turn-scoped read: beforeTurn saw the metadata for exactly this turn.
    const captured = (await agent.getCapturedTurnMetadataForTest()) as (
      | Record<string, unknown>
      | undefined
    )[];
    expect(captured.at(-1)).toEqual({
      actingUserId: "user-123",
      origin: "slack"
    });

    // Durably stamped alongside the channel on the user message.
    const messages = (await agent.getMessages()) as UIMessage[];
    const user = messages.find((m) => m.role === "user");
    expect(user?.metadata).toMatchObject({
      channel: "voice",
      turnMetadata: { actingUserId: "user-123", origin: "slack" }
    });
  });

  it("re-resolves turn metadata from durable history (recovery read path)", async () => {
    const agent = await freshAgent(`turn-meta-recover-${crypto.randomUUID()}`);

    // Simulate a recovered continuation: the stamped user message is all that
    // survives — no in-memory turn state.
    await agent.persistTestMessage({
      id: "u-meta",
      role: "user",
      parts: [{ type: "text", text: "recovered turn" }],
      metadata: {
        channel: "voice",
        turnMetadata: { actingUserId: "user-456" }
      }
    });

    expect(await agent.getActiveTurnMetadataForTest()).toEqual({
      actingUserId: "user-456"
    });
  });

  it("returns undefined when the latest user message carries none", async () => {
    const agent = await freshAgent(`turn-meta-none-${crypto.randomUUID()}`);
    await agent.persistTestMessage({
      id: "u-plain",
      role: "user",
      parts: [{ type: "text", text: "no metadata here" }]
    });
    expect(await agent.getActiveTurnMetadataForTest()).toBeUndefined();
  });

  it("strips reserved metadata keys from client-supplied messages at intake", async () => {
    const agent = await freshAgent(`turn-meta-forge-${crypto.randomUUID()}`);

    await agent.persistIncomingMessageForTest({
      id: "u-forged",
      role: "user",
      parts: [{ type: "text", text: "I forged my identity" }],
      metadata: {
        channel: "voice",
        turnMetadata: { actingUserId: "victim-user" },
        harmless: "kept"
      }
    } as UIMessage);

    const messages = (await agent.getMessages()) as UIMessage[];
    const stored = messages.find((m) => m.id === "u-forged");
    expect(stored).toBeDefined();
    const metadata = stored?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.harmless).toBe("kept");
    expect(metadata && "channel" in metadata).toBe(false);
    expect(metadata && "turnMetadata" in metadata).toBe(false);

    // And the forged identity is not readable as turn metadata.
    expect(await agent.getActiveTurnMetadataForTest()).toBeUndefined();
  });
});
