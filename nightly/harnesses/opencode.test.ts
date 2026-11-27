// The OpenCode harness on a real deployment. OpenCode runs inside the
// Durable Object (no container), so a session must survive the object
// resetting mid model call and a code update mid call, brought back by the
// harness's wake job: the suite waits on the witness, not on the probe, until
// the replayed call shows. A real Workers AI conversation with a tool goes
// through a reset. Each room ends with nothing pending and no alarm (OpenCode
// is closed 30 s after its last use).

import { describe, expect, inject, it } from "vitest";
import { deployHarnesses } from "./deploy";
import {
  call,
  converse,
  ended,
  idle,
  reset,
  seen,
  submit,
  witness
} from "./lib";

describe("the OpenCode harness on a deployment", () => {
  it("replays a run cut off by a reset mid-call, woken by its own alarm", async () => {
    const room = `reset-${Date.now()}`;
    const { operationId } = await submit("opencode", room, "hold");
    await seen(room, "hold", 1);
    await reset("opencode", room);
    // OpenCode replays the turn after the restart: a second call.
    await seen(room, "hold", 2).catch(async (e) => {
      // Say where the session stood: its alarm, wake jobs and pending work.
      throw new Error(
        `${String(e)}; ${JSON.stringify(await call("opencode", room, "probeDiag"))}`
      );
    });
    await call("opencode", room, "probeRelease");
    expect(await ended("opencode", room, operationId)).toMatchObject({
      status: "done",
      text: "echo: hold"
    });
    expect(await witness(room, "hold")).toBe(2);
    await idle("opencode", room);
  });

  it("replays a run cut off by a code update mid-call", async () => {
    const room = `update-${Date.now()}`;
    const { operationId } = await submit("opencode", room, "hold");
    await seen(room, "hold", 1);
    await deployHarnesses(
      inject("probeName"),
      inject("probeKey"),
      "opencode-update"
    );
    await seen(room, "hold", 2).catch(async (e) => {
      throw new Error(
        `${String(e)}; ${JSON.stringify(await call("opencode", room, "probeDiag"))}`
      );
    });
    await call("opencode", room, "probeRelease");
    expect(await ended("opencode", room, operationId)).toMatchObject({
      status: "done",
      text: "echo: hold"
    });
    await idle("opencode", room);
  });

  // Five turns at up to 100 s each (measured on glm-4.7-flash); each turn
  // gets 180 s, so the case is bounded at 5 x 180 s plus the idle check.
  it("holds a real conversation with a tool through a reset", async () => {
    const room = `real-${Date.now()}`;
    const answers = await converse("opencode", room, {
      turns: 5,
      resets: [3],
      perTurnMs: 180_000,
      prompt: (turn) =>
        `Use the shout tool on the text "turn ${turn}", then reply with exactly what it returned.`,
      want: (turn) => `TURN ${turn}`
    });
    const report = JSON.stringify(answers);
    expect(
      answers.every((a) => a.status === "done"),
      report
    ).toBe(true);
    // Each turn not cut by a reset carries its own shout. A reset turn is
    // told the server restarted, and what the model says to that is its own.
    expect(
      answers.every((a) => a.reset || a.text?.includes(a.want)),
      report
    ).toBe(true);
    expect(await witness(room, "start"), report).toBeGreaterThanOrEqual(2);
    // The saved conversation kept every turn through the reset.
    const { entries } = await call<{ entries: number }>(
      "opencode",
      room,
      "probeState"
    );
    expect(entries, report).toBeGreaterThanOrEqual(10);
    await idle("opencode", room);
  }, 1_020_000);
});
