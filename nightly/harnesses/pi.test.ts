// The Pi harness on a real deployment, with the real wake timings (a 30 s
// heartbeat). After a reset or a code update the suite does not touch the
// probe until the witness (a separate object the tools report to) shows the
// tool ran again: only the harness's own wake job can have brought the probe
// back. Every room ends with nothing pending and no alarm.

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

describe("the Pi harness on a deployment", () => {
  it("re-runs a replay-safe tool cut off by a reset once, woken by its own alarm", async () => {
    const room = `safe-${Date.now()}`;
    const { operationId } = await submit("pi", room, "gate");
    await seen(room, "gate", 1);
    await reset("pi", room);
    await seen(room, "gate", 2);
    await call("pi", room, "probeRelease");
    expect((await ended("pi", room, operationId)).status).toBe("done");
    expect(await witness(room, "gate")).toBe(2);
    await idle("pi", room);
  });

  it("tells the model an unsafe tool was interrupted instead of running it again", async () => {
    const room = `unsafe-${Date.now()}`;
    const { operationId } = await submit("pi", room, "gate_unsafe");
    await seen(room, "gate_unsafe", 1);
    await reset("pi", room);
    // The probe started again on its own, and did not run the tool again.
    await seen(room, "start", 2);
    await call("pi", room, "probeRelease");
    const result = await ended("pi", room, operationId);
    expect(result.status).toBe("done");
    expect(result.text).toMatch(/^tool failed/);
    expect(await witness(room, "gate_unsafe")).toBe(1);
    await idle("pi", room);
  });

  it("finishes a tool run that a code update cut off", async () => {
    const room = `update-${Date.now()}`;
    const { operationId } = await submit("pi", room, "gate");
    await seen(room, "gate", 1);
    // An immediate code update resets the busy object.
    await deployHarnesses(inject("probeName"), inject("probeKey"), "pi-update");
    await seen(room, "gate", 2);
    await call("pi", room, "probeRelease");
    expect((await ended("pi", room, operationId)).status).toBe("done");
    expect(await witness(room, "gate")).toBe(2);
    await idle("pi", room);
  });

  it("parks a call on a deadline, lets the object go idle, and wakes it by alarm", async () => {
    const room = `park-${Date.now()}`;
    const { operationId } = await submit("pi", room, "deadline");
    await seen(room, "deadline-parked", 1);
    // Nothing touches the probe until the deadline's wake has finished the call.
    await seen(room, "deadline-woke", 1, 150_000);
    const result = await ended("pi", room, operationId);
    expect(result).toMatchObject({ status: "done" });
    // The deadline passed: not a signal, not a restart.
    expect(result.text).toMatch(/woke time/);
    await idle("pi", room);
  });

  it("replays a codemode script cut off by a reset: journaled calls once, the gate again", async () => {
    const room = `codemode-${Date.now()}`;
    const { operationId } = await submit("pi", room, "codemode");
    await seen(room, "gate", 1);
    await reset("pi", room);
    await seen(room, "gate", 2);
    await call("pi", room, "probeRelease");
    const result = await ended("pi", room, operationId);
    expect(result.status).toBe("done");
    expect(result.text).toMatch(/^tool said/);
    expect(await witness(room, "multiply")).toBe(1);
    await idle("pi", room);
  });

  it("runs a browser tool call on a real Browser Rendering session", async () => {
    const room = `browser-${Date.now()}`;
    const { operationId } = await submit("pi", room, "browser");
    const result = await ended("pi", room, operationId);
    expect(result.status).toBe("done");
    expect(result.text, result.text).toMatch(/^tool said/);
    await idle("pi", room);
  });

  // Ten turns at about 40 s each (measured on glm-4.7-flash); each turn gets
  // 120 s, so the case is bounded at 10 x 120 s plus the idle check.
  it("holds a ten-turn conversation with tools on Workers AI through two resets", async () => {
    const room = `real-${Date.now()}`;
    const answers = await converse("pi", room, {
      turns: 10,
      resets: [4, 8],
      perTurnMs: 120_000,
      prompt: (turn) =>
        `What is ${turn * 7} times three? Use the multiply tool, then answer with the number only.`,
      want: (turn) => String(turn * 21)
    });
    const report = JSON.stringify(answers);
    expect(
      answers.every((a) => a.status === "done"),
      report
    ).toBe(true);
    // Every turn not cut by a reset answered its own question. A reset turn
    // is told the server restarted, and what the model says to that is its own.
    expect(
      answers.every((a) => a.reset || a.text?.includes(a.want)),
      report
    ).toBe(true);
    expect(await witness(room, "multiply"), report).toBeGreaterThanOrEqual(1);
    expect(await witness(room, "start"), report).toBeGreaterThanOrEqual(3);
    // The saved conversation kept every turn through both resets: a user
    // message and a reply for each of the ten.
    const { entries } = await call<{ entries: number }>(
      "pi",
      room,
      "probeState"
    );
    expect(entries, report).toBeGreaterThanOrEqual(20);
    await idle("pi", room);
  }, 1_320_000);
});
