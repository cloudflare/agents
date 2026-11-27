/**
 * Chat recovery as an app sees it: a model stream that stalls, the app's
 * `chatRecovery` and `onChatRecovery`, and what the conversation holds once
 * the agent is stable. Public API only, so it runs on Think and on the
 * harness-backed Think alike.
 */
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkTestAgent, `${name}-${crypto.randomUUID()}`);
}

describe("chat recovery, through public behaviour", () => {
  it("continues a stalled turn and calls onChatRecovery with its partial", async () => {
    const agent = await freshAgent("recover-stall");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50
    });

    expect(result.stable).toBe(true);
    expect(result.recoveryCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.recoveryCalls[0]).toMatchObject({
      attempt: 1,
      recoveryKind: "continue",
      partialText: "Hello from the assistant!"
    });
    expect(result.roles).toEqual(["user", "assistant"]);
  });

  it("gives up a stalled turn when onChatRecovery declines to continue", async () => {
    const agent = await freshAgent("recover-decline");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50,
      recovery: { continue: false }
    });

    expect(result.first.error).toBeTruthy();
    expect(result.recoveryCalls).toHaveLength(1);
    expect(result.stable).toBe(true);
  });

  it("asks onChatRecovery no more often than chatRecovery's attempts allow", async () => {
    const agent = await freshAgent("recover-spent");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 5,
      timeoutMs: 50,
      chatRecovery: { maxAttempts: 1 }
    });

    expect(result.stable).toBe(true);
    expect(result.recoveryCalls).toHaveLength(1);
    // The interrupted reply's text is kept.
    expect(result.lastAssistantText).toContain("Hello from the assistant!");
  });

  it("recovers a stall when only beforeTurn sets the stall timeout", async () => {
    const agent = await freshAgent("recover-per-turn");
    const result = await agent.stallRecoveryForTest({
      afterParts: 2,
      stalledCalls: 1,
      timeoutMs: 50,
      perTurn: true
    });

    expect(result.stable).toBe(true);
    expect(result.recoveryCalls[0]).toMatchObject({ attempt: 1 });
    expect(result.roles).toEqual(["user", "assistant"]);
  });
});
