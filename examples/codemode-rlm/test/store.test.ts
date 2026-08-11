/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INPUT_CHUNK_CHARS } from "../src/core";

async function post(path: string, value: unknown): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
}

describe("minimal RLM durable state", () => {
  it("discovers and persists a Computer workspace across connector calls", async () => {
    const instance = "computer-workspace";
    await expect(
      (await post(`/workspace-describe?instance=${instance}`, {})).json()
    ).resolves.toMatchObject({
      methods: ["edit", "ls", "read", "write"],
      types: expect.stringContaining("declare const workspace")
    });

    await expect(
      (
        await post(`/workspace-write?instance=${instance}`, {
          path: "/workspace/memory.json",
          content: '{"answer":41}'
        })
      ).json()
    ).resolves.toEqual({
      path: "/workspace/memory.json",
      bytesWritten: 13
    });

    await expect(
      (
        await post(`/workspace-edit?instance=${instance}`, {
          path: "/workspace/memory.json",
          edits: [{ oldText: "41", newText: "42" }]
        })
      ).json()
    ).resolves.toMatchObject({
      path: "/workspace/memory.json",
      editsApplied: 1
    });

    await expect(
      (
        await post(`/workspace-read?instance=${instance}`, {
          path: "/workspace/memory.json"
        })
      ).json()
    ).resolves.toMatchObject({
      path: "/workspace/memory.json",
      content: '{"answer":42}'
    });
  });

  it("persists workspace files written by generated JavaScript", async () => {
    const instance = "generated-computer-workspace";
    await expect(
      (await post(`/workspace-generated?instance=${instance}`, {})).json()
    ).resolves.toMatchObject({
      result: {
        path: "/workspace/generated.txt",
        content: "written by generated JavaScript"
      }
    });

    await expect(
      (
        await post(`/workspace-generated?instance=${instance}`, {
          action: "read"
        })
      ).json()
    ).resolves.toMatchObject({
      result: {
        path: "/workspace/generated.txt",
        content: "written by generated JavaScript"
      }
    });
  });

  it("binds a request and input id to exact external data", async () => {
    const input = {
      id: "input-replay",
      requestId: "request-replay",
      task: "alpha",
      material: "beta"
    };
    expect((await post("/input?instance=input", input)).status).toBe(200);
    expect((await post("/input?instance=input", input)).status).toBe(200);

    const changed = await post("/input?instance=input", {
      ...input,
      task: "omega"
    });
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({
      error: expect.stringMatching(/different data/)
    });

    const reusedRequest = await post("/input?instance=input", {
      ...input,
      id: "another-input"
    });
    expect(reusedRequest.status).toBe(409);
    await expect(reusedRequest.json()).resolves.toMatchObject({
      error: expect.stringMatching(/request id.*reused/)
    });
  });

  it("exposes only inputs activated by the current causal turn", async () => {
    const response = await post("/visibility?instance=visibility", {
      prefix: "causal"
    });
    await expect(response.json()).resolves.toEqual({
      before: ["causal:first"],
      fromFirst: ["causal:first"],
      fromSecond: ["causal:second", "causal:first"],
      secondVisibleFromFirst: false
    });
  });

  it("finds literal text across storage chunk boundaries", async () => {
    const material = `${"x".repeat(INPUT_CHUNK_CHARS - 2)}needle`;
    const response = await post("/search?instance=search", {
      id: "boundary",
      material
    });
    await expect(response.json()).resolves.toMatchObject([
      {
        offset: INPUT_CHUNK_CHARS - 2,
        preview: expect.stringContaining("needle")
      }
    ]);
  });

  it("charges recursive budget once across replay", async () => {
    const operation = {
      id: "operation-replay",
      rootInputId: "root-turn",
      argsHash: "args-a",
      childId: "child-a",
      turnInputId: "child-turn-a"
    };
    await expect(
      (await post("/operation?instance=operation", operation)).json()
    ).resolves.toEqual({
      created: true,
      used: 1
    });
    await expect(
      (await post("/operation?instance=operation", operation)).json()
    ).resolves.toEqual({
      created: false,
      used: 1
    });

    const changed = await post("/operation?instance=operation", {
      ...operation,
      argsHash: "args-b"
    });
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({
      error: expect.stringMatching(/different arguments/)
    });
  });

  it("serves kernel.finish only after its Code Mode execution verifies", async () => {
    await expect(
      (
        await post("/answer?instance=answers", {
          inputId: "input",
          executionId: "exec"
        })
      ).json()
    ).resolves.toEqual({ before: null, after: "done" });
    await expect(
      (
        await post("/failed-answer?instance=answers", {
          inputId: "failed",
          executionId: "exec-failed"
        })
      ).json()
    ).resolves.toEqual({ answer: null });

    await expect(
      (
        await post("/answer-execution?instance=answers", {
          inputId: "execution-bound"
        })
      ).json()
    ).resolves.toEqual({ verified: true, wrongExecution: false });

    await expect(
      (await post("/answer-race?instance=answer-race", {})).json()
    ).resolves.toEqual({
      recovered: true,
      recoveredAnswer: "first",
      winner: true,
      loser: false,
      winnerAnswer: "second",
      rolledBack: null
    });
  });

  it("bounds durable kernel keys without blocking updates", async () => {
    await expect(
      (await post("/kernel-cap?instance=kernel", {})).json()
    ).resolves.toMatchObject({
      rejected: true,
      existing: "updated",
      error: expect.stringMatching(/256 keys/)
    });
  });

  it("versions and rolls back the compact continual harness", async () => {
    const first = await post("/harness?instance=harness", {
      id: "depth",
      content: "Prefer depth one.",
      reason: "user preference"
    });
    await expect(first.json()).resolves.toMatchObject({
      revision: 1,
      entries: [{ id: "depth", kind: "memory", content: "Prefer depth one." }]
    });

    const second = await post("/harness?instance=harness", {
      id: "citations",
      content: "Cite evidence.",
      reason: "observed omission"
    });
    await expect(second.json()).resolves.toMatchObject({ revision: 2 });

    const rollback = await post("/rollback?instance=harness", {
      targetRevision: 1
    });
    await expect(rollback.json()).resolves.toEqual({
      revision: 3,
      entries: [
        expect.objectContaining({ id: "depth", content: "Prefer depth one." })
      ]
    });
  });

  it("allows one idempotent harness mutation per refinement input", async () => {
    await expect(
      (await post("/harness-once?instance=harness-once", {})).json()
    ).resolves.toMatchObject({
      firstRevision: 1,
      replayRevision: 1,
      rejected: true,
      error: expect.stringMatching(/already made a different/)
    });
  });

  it("returns the requested number of pending history messages", async () => {
    const history = await post("/history-limit?instance=history", {});
    const messages = (await history.json()) as Array<{ content: string }>;
    expect(messages).toHaveLength(6);
    expect(Math.max(...messages.map((message) => message.content.length))).toBe(
      8_192
    );
  });
});
