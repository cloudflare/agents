import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCenterAgent } from "../src/command-center";

describe("agent-think reliability", () => {
  afterEach(() => vi.useRealTimers());

  it("reclaims a stale running continuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z"));
    const session = `stale-${crypto.randomUUID()}`;
    const commandCenter = await getAgentByName<Env, CommandCenterAgent>(
      env.CommandCenter,
      "main"
    );
    await commandCenter.recordDispatch({
      session,
      repo: "cloudflare/agents",
      issueNumber: 1,
      instruction: "test"
    });

    expect(await commandCenter.claimContinuation(session)).toEqual({
      ok: false,
      reason: "not_recoverable"
    });
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await commandCenter.claimContinuation(session)).toMatchObject({
      ok: true,
      thread: { status: "running" }
    });
  });

  it("claims a failed continuation only once", async () => {
    const session = `continuation-${crypto.randomUUID()}`;
    const commandCenter = await getAgentByName<Env, CommandCenterAgent>(
      env.CommandCenter,
      "main"
    );
    await commandCenter.recordDispatch({
      session,
      repo: "cloudflare/agents",
      issueNumber: 1,
      instruction: "test"
    });
    await commandCenter.recordTurn({
      session,
      outcome: "error",
      error: "payment required"
    });

    expect(await commandCenter.claimContinuation(session)).toMatchObject({
      ok: true,
      thread: { status: "error" }
    });
    expect(await commandCenter.claimContinuation(session)).toEqual({
      ok: false,
      reason: "not_recoverable"
    });
    expect((await commandCenter.getSnapshot()).threads[session]).toMatchObject({
      status: "running",
      runs: 2,
      lastError: undefined
    });
  });

  it("records terminal command-center state through the real DO", async () => {
    const session = `reliability-${crypto.randomUUID()}`;
    const commandCenter = await getAgentByName<Env, CommandCenterAgent>(
      env.CommandCenter,
      session
    );
    await commandCenter.recordDispatch({
      session,
      repo: "cloudflare/agents",
      issueNumber: 1,
      instruction: "test"
    });
    await commandCenter.recordTurn({
      session,
      outcome: "error",
      error: "recovery exhausted"
    });

    expect((await commandCenter.getSnapshot()).threads[session]).toMatchObject({
      status: "error",
      lastError: "recovery exhausted"
    });
  });
});
