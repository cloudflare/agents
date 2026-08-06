/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function post(path: string, value: unknown): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
}

describe("durable recovery ledgers", () => {
  it("accepts exact input replay and rejects same-length replacement data", async () => {
    const first = await post("/input", {
      id: "input-replay",
      task: "alpha",
      material: "beta"
    });
    expect(first.status).toBe(200);

    const replay = await post("/input", {
      id: "input-replay",
      task: "alpha",
      material: "beta"
    });
    expect(replay.status).toBe(200);

    const mismatch = await post("/input", {
      id: "input-replay",
      task: "omega",
      material: "beta"
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: expect.stringMatching(/different data/)
    });
  });

  it("charges one recursive call across different Code Mode executions", async () => {
    const base = {
      id: "operation-replay",
      rootInputId: "root-turn",
      argsHash: "args-a",
      childId: "child-a",
      turnInputId: "child-turn-a"
    };
    const first = await post("/operation", {
      ...base,
      executionId: "exec-a"
    });
    expect(await first.json()).toMatchObject({ created: true, used: 1 });

    const replay = await post("/operation", {
      ...base,
      executionId: "exec-b"
    });
    expect(await replay.json()).toMatchObject({ created: false, used: 1 });

    const mismatch = await post("/operation", {
      ...base,
      argsHash: "args-b",
      executionId: "exec-c"
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: expect.stringMatching(/different arguments/)
    });
  });

  it("binds a caller request id to one canonical root input", async () => {
    const request = {
      requestId: "http-request-replay",
      argsHash: "request-args-a",
      inputId: "request-input-a"
    };
    expect((await post("/request", request)).status).toBe(200);
    expect((await post("/request", request)).status).toBe(200);

    const mismatch = await post("/request", {
      ...request,
      argsHash: "request-args-b"
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: expect.stringMatching(/different arguments/)
    });
  });

  it("records child transcript turns once and finalizes finish ownership", async () => {
    const transcript = await post("/transcript", {
      inputId: "child-turn-transcript"
    });
    expect(await transcript.json()).toEqual({
      writes: [true, false, true, false],
      messages: 2
    });

    const execution = await post("/execution", {
      executionId: "exec-finish",
      inputId: "input-finish"
    });
    expect(await execution.json()).toEqual({
      status: "completed",
      belongs: true,
      answer: "done"
    });
  });

  it("exposes only inputs activated by the current causal turn", async () => {
    const result = await post("/visibility?instance=visibility", {
      prefix: "causal"
    });
    expect(await result.json()).toEqual({
      before: ["causal:first"],
      fromFirst: ["causal:first"],
      fromSecond: ["causal:second", "causal:first"],
      secondVisibleFromFirst: false
    });
  });

  it("prevents a stale child refresh from rolling its head backward", async () => {
    const result = await post("/child-cas?instance=child-cas", {
      prefix: "cas"
    });
    expect(await result.json()).toMatchObject({
      advanced: true,
      stale: false,
      child: {
        inputId: "cas:input-2",
        status: "admitted"
      }
    });
  });

  it("does not let a same-turn stale refresh erase a terminal child", async () => {
    const result = await post("/child-terminal-cas?instance=child-terminal", {
      prefix: "terminal"
    });
    expect(await result.json()).toMatchObject({
      running: true,
      completed: true,
      stale: false,
      duplicate: false,
      child: {
        inputId: "terminal:input",
        status: "completed",
        answer: "terminal answer"
      }
    });
  });

  it("atomically reserves immutable snippet names and enforces the cap", async () => {
    const instance = "snippet-ledger";
    expect(
      (
        await post(`/promotion?instance=${instance}`, {
          name: "skill_v1",
          maximum: 2
        })
      ).status
    ).toBe(200);
    const duplicate = await post(`/promotion?instance=${instance}`, {
      name: "skill_v1",
      maximum: 2
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: expect.stringMatching(/already exists or is reserved/)
    });
    expect(
      (
        await post(`/promotion?instance=${instance}`, {
          name: "skill_v2",
          maximum: 2
        })
      ).status
    ).toBe(200);
    const overLimit = await post(`/promotion?instance=${instance}`, {
      name: "skill_v3",
      maximum: 2
    });
    expect(overLimit.status).toBe(409);
    await expect(overLimit.json()).resolves.toMatchObject({
      error: expect.stringMatching(/at most 2/)
    });
  });

  it("admits only one of two concurrent claims for the final snippet slot", async () => {
    const instance = "snippet-race";
    const responses = await Promise.all([
      post(`/promotion?instance=${instance}`, { name: "left_v1", maximum: 1 }),
      post(`/promotion?instance=${instance}`, {
        name: "right_v1",
        maximum: 1
      })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409
    ]);
  });

  it("prunes rollback-created full snapshots to the retention window", async () => {
    const result = await post(
      "/rollback-retention?instance=rollback-retention",
      {}
    );
    expect(await result.json()).toEqual({
      revision: 105,
      retained: 100,
      oldRevisionPresent: false
    });
  });
});
