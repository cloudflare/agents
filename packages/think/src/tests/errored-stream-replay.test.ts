import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents";

/**
 * #1575 parity for Think: a client reconnecting after an in-band stream error
 * must observe the same terminal outcome a live client did — the partial
 * content the model produced before the error, replayed first, then a terminal
 * `done: true, error: true` frame. This mirrors the ai-chat coverage; Think's
 * `_replayTerminalOnAck` is the same fix in a separate package, so it needs its
 * own guard.
 */

type Frame = Record<string, unknown>;

type ThinkReplayStub = {
  replayTerminalOnAckCaptureForTest(
    errorText: string
  ): Promise<{ returned: boolean; frames: Frame[] }>;
};

async function freshAgent(name: string): Promise<ThinkReplayStub> {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  ) as unknown as Promise<ThinkReplayStub>;
}

describe("Think errored stream replay (#1575)", () => {
  it("replays pre-error partial content before the terminal error on resume-ACK", async () => {
    const agent = await freshAgent(`inband-replay-${crypto.randomUUID()}`);

    const { returned, frames } =
      await agent.replayTerminalOnAckCaptureForTest("boom");

    // The terminal was pending and handled.
    expect(returned).toBe(true);

    // The partial content is replayed (replay frames carry the buffered
    // chunk bodies) before any terminal frame.
    const replayBodies = frames
      .filter((f) => f.replay === true && typeof f.body === "string")
      .map((f) => f.body as string)
      .join("");
    expect(replayBodies).toContain("partial response");

    // The last frame is the terminal error with the recorded error text.
    const terminal = frames[frames.length - 1];
    expect(terminal?.done).toBe(true);
    expect(terminal?.error).toBe(true);
    expect(terminal?.body).toBe("boom");

    // No terminal frame appears before the replayed content.
    const terminalIndex = frames.findIndex(
      (f) => f.done === true && f.error === true
    );
    const firstReplayIndex = frames.findIndex((f) => f.replay === true);
    expect(firstReplayIndex).toBeGreaterThanOrEqual(0);
    expect(firstReplayIndex).toBeLessThan(terminalIndex);
  });
});
