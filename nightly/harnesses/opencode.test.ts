// The OpenCode harness on a real deployment. OpenCode runs inside the
// Durable Object (no container), so a session must survive the object
// resetting mid model call and a code update mid call, brought back by the
// harness's wake job: the suite waits on the witness, not on the probe, until
// the replayed call shows. A real Workers AI conversation with a tool goes
// through a reset. Each room ends with nothing pending and no alarm (OpenCode
// is closed 30 s after its last use).

import { describe, expect, inject, it } from "vitest";
import { deployHarnesses } from "./deploy";
import { call, ended, idle, reset, seen, submit, witness } from "./lib";

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

  it("holds a real conversation with a tool through a reset", async () => {
    const room = `real-${Date.now()}`;
    const answers: { status: string; text?: string; want: string }[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      const { operationId } = await submit(
        "opencode",
        room,
        `Use the shout tool on the text "turn ${turn}", then reply with exactly what it returned.`
      );
      if (turn === 3) await reset("opencode", room);
      answers.push({
        ...(await ended("opencode", room, operationId)),
        want: `TURN ${turn}`
      });
    }
    const report = JSON.stringify(answers);
    expect(
      answers.every((a) => a.status === "done"),
      report
    ).toBe(true);
    // Each reply carries its own turn's shout: the tool ran, nothing was lost.
    expect(
      answers.every((a) => a.text?.includes(a.want)),
      report
    ).toBe(true);
    expect(await witness(room, "start"), report).toBeGreaterThanOrEqual(2);
    await idle("opencode", room);
  }, 600_000);
});
