/**
 * Baseline: the loop runs, journals, and survives eviction.
 *
 * These are the tests that have to pass before any bug fix is meaningful,
 * because they establish that the scripted model drives the real loop.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestAgent } from "./worker";

function fresh(): DurableObjectStub<TestAgent> {
  return env.TINY_TEST.getByName(crypto.randomUUID());
}

describe("the turn loop", () => {
  it("uses capabilities without creating harness-owned SQL tables", async () => {
    const stub = fresh();
    stub.configure({ rounds: [{ kind: "text", text: "pong" }] });
    await stub.runToSettled("hello");
    expect(await stub.harnessTables()).toEqual([]);
  });

  it("completes a single-round turn", async () => {
    const stub = fresh();
    stub.configure({ rounds: [{ kind: "text", text: "pong" }] });

    const turn = await stub.runToSettled("Reply with exactly: pong");

    expect(turn.status).toBe("completed");
    expect(turn.text).toBe("pong");
    expect(turn.rounds).toBe(1);
  });

  it("reports token usage on the AG-UI run", async () => {
    const stub = fresh();
    stub.configure({ rounds: [{ kind: "text", text: "ok" }] });

    const turn = await stub.runToSettled("hi");
    const events = await stub.events(turn.turnId);
    const finished = events.find((event) => event.type === "RUN_FINISHED");

    expect(finished).toMatchObject({
      usage: [{ inputTokens: 11, outputTokens: 7 }]
    });
  });

  // A turn whose Task run throws must end up `failed` on its own row. The
  // loop only calls `settle()` on the success path, so before the fix this
  // turn stays `queued` forever and a client spins indefinitely.
  it("fails the turn when the round budget is exhausted", async () => {
    const stub = fresh();
    // Always asks for a tool, so it never terminates on its own.
    const askForRead = (id: string) => ({
      kind: "tools" as const,
      calls: [{ id, name: "read", input: { path: "/workspace/AGENTS.md" } }]
    });
    stub.configure({
      maxRounds: 2,
      rounds: [askForRead("c1"), askForRead("c2"), askForRead("c3")]
    });

    const turn = await stub.runToSettled("loop forever");
    expect(turn.status).toBe("failed");
    expect(turn.error).toMatch(/model rounds/i);

    const events = await stub.events(turn.turnId);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: expect.stringMatching(/model rounds/i)
    });
  });

  it("is idempotent on turn id", async () => {
    const stub = fresh();
    stub.configure({ rounds: [{ kind: "text", text: "once" }] });

    const first = await stub.submit("do it", "fixed-turn-id");
    const second = await stub.submit("do it", "fixed-turn-id");

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.turnId).toBe(first.turnId);

    await stub.waitForSettled(first.turnId);
    expect((await stub.turns()).length).toBe(1);
  });
});

