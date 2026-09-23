import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { z } from "zod";
import { action } from "../think";

async function freshPauseAgent(name: string) {
  return getAgentByName(env.ThinkToolsTestAgent, name);
}

type PausedOutput = {
  status?: string;
  executionId?: string;
  action?: string;
  message?: string;
  reason?: string;
  error?: string;
};

describe("durable-pause actions", () => {
  it("parks for approval without running the side effect", async () => {
    const agent = await freshPauseAgent(`dp-park-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();

    const output = (await agent.parkDurablePauseForTest(
      "hello"
    )) as PausedOutput;

    expect(output.status).toBe("paused");
    expect(output.executionId).toMatch(/^actpause_/);
    expect(output.action).toBe("pauseAction");
    // The rich descriptor must NOT leak into the model-visible output.
    expect(output).not.toHaveProperty("descriptor");
    expect(output).not.toHaveProperty("permissions");

    expect(await agent.getDurablePauseExecCount()).toBe(0);

    const pending = await agent.listActionPendingForTest();
    expect(pending).toHaveLength(1);
    expect(pending[0].action_name).toBe("pauseAction");
    expect(pending[0].execution_id).toBe(output.executionId);
    expect(pending[0].descriptor_json).toBeTruthy();
  });

  it("lists the parked action via pendingApprovals with its descriptor", async () => {
    const agent = await freshPauseAgent(`dp-list-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const output = (await agent.parkDurablePauseForTest("hi")) as PausedOutput;

    const approvals = JSON.parse(
      await agent.pendingApprovalsForTest()
    ) as Array<{
      executionId: string;
      source: string;
      descriptor: Record<string, unknown>;
    }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].executionId).toBe(output.executionId);
    expect(approvals[0].source).toBe("action");
    const descriptor = approvals[0].descriptor;
    expect(descriptor.action).toBe("pauseAction");
    expect(descriptor.summary).toBe("Approve pause action");
    expect(descriptor.kind).toBe("durable-pause");
    expect(descriptor.risk).toBe("high");
    expect(descriptor.permissions).toEqual(["pause:run"]);
    expect(descriptor.input).toEqual({ message: "hi" });
  });

  it("runs the action exactly once on approve and clears the pending row", async () => {
    const agent = await freshPauseAgent(`dp-approve-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const parked = (await agent.parkDurablePauseForTest(
      "world"
    )) as PausedOutput;

    const result = await agent.approveExecutionForTest(
      parked.executionId ?? ""
    );

    expect(result).toBe("paused-exec: world");
    expect(await agent.getDurablePauseExecCount()).toBe(1);
    expect(await agent.listActionPendingForTest()).toHaveLength(0);
  });

  it("rejects without running the action and clears the pending row", async () => {
    const agent = await freshPauseAgent(`dp-reject-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const parked = (await agent.parkDurablePauseForTest(
      "nope"
    )) as PausedOutput;

    const result = (await agent.rejectExecutionForTest(
      parked.executionId ?? "",
      "not now"
    )) as PausedOutput;

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("not now");
    expect(await agent.getDurablePauseExecCount()).toBe(0);
    expect(await agent.listActionPendingForTest()).toHaveLength(0);
  });

  it("errors on a second approve and never double-executes (claim-by-delete)", async () => {
    const agent = await freshPauseAgent(`dp-double-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const parked = (await agent.parkDurablePauseForTest(
      "once"
    )) as PausedOutput;
    const id = parked.executionId ?? "";

    const first = await agent.approveExecutionForTest(id);
    const second = (await agent.approveExecutionForTest(id)) as PausedOutput;

    expect(first).toBe("paused-exec: once");
    expect(second.status).toBe("error");
    expect(second.error).toMatch(/no longer pending/);
    expect(await agent.getDurablePauseExecCount()).toBe(1);
  });

  it("errors on approve-after-reject", async () => {
    const agent = await freshPauseAgent(`dp-rejapp-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const parked = (await agent.parkDurablePauseForTest("x")) as PausedOutput;
    const id = parked.executionId ?? "";

    await agent.rejectExecutionForTest(id);
    const approve = (await agent.approveExecutionForTest(id)) as PausedOutput;

    expect(approve.status).toBe("error");
    expect(await agent.getDurablePauseExecCount()).toBe(0);
  });

  it("picks a single winner under concurrent approves", async () => {
    const agent = await freshPauseAgent(`dp-race-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const parked = (await agent.parkDurablePauseForTest(
      "race"
    )) as PausedOutput;

    const [a, b] = (await agent.approveExecutionTwiceForTest(
      parked.executionId ?? ""
    )) as PausedOutput[];

    const outcomes = [a, b];
    const succeeded = outcomes.filter(
      (o) => o === ("paused-exec: race" as unknown)
    );
    const errored = outcomes.filter(
      (o) => (o as PausedOutput)?.status === "error"
    );
    expect(succeeded).toHaveLength(1);
    expect(errored).toHaveLength(1);
    expect(await agent.getDurablePauseExecCount()).toBe(1);
  });

  it("runs inline (no park) when the approval predicate returns false", async () => {
    const agent = await freshPauseAgent(`dp-inline-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest({ approval: "predicate-hello" });

    // message !== "hello" → predicate false → inline execution, no park.
    const output = await agent.parkDurablePauseForTest("other");

    expect(output).toBe("paused-exec: other");
    expect(await agent.getDurablePauseExecCount()).toBe(1);
    expect(await agent.listActionPendingForTest()).toHaveLength(0);
  });

  it("parks when the approval predicate returns true", async () => {
    const agent = await freshPauseAgent(`dp-predtrue-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest({ approval: "predicate-hello" });

    const output = (await agent.parkDurablePauseForTest(
      "hello"
    )) as PausedOutput;

    expect(output.status).toBe("paused");
    expect(await agent.getDurablePauseExecCount()).toBe(0);
    expect(await agent.listActionPendingForTest()).toHaveLength(1);
  });

  it("returns a structured error when the action was removed before approve", async () => {
    const agent = await freshPauseAgent(`dp-removed-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const parked = (await agent.parkDurablePauseForTest(
      "gone"
    )) as PausedOutput;

    await agent.removeDurablePauseActionForTest();
    const result = (await agent.approveExecutionForTest(
      parked.executionId ?? ""
    )) as PausedOutput;

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/no longer registered/);
    expect(await agent.getDurablePauseExecCount()).toBe(0);
    // The approval was consumed (claim-by-delete) even though it couldn't run.
    expect(await agent.listActionPendingForTest()).toHaveLength(0);
  });

  it("does not double-execute across a duplicate approve when idempotency-keyed", async () => {
    const agent = await freshPauseAgent(`dp-idem-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest({ idempotencyKey: "dp-key" });
    const parked = (await agent.parkDurablePauseForTest(
      "keyed"
    )) as PausedOutput;

    const first = await agent.approveExecutionForTest(parked.executionId ?? "");
    expect(first).toBe("paused-exec: keyed");

    // Park + approve a SECOND time with the same idempotency key: the ledger
    // replays the settled result rather than re-running the side effect.
    const parked2 = (await agent.parkDurablePauseForTest(
      "keyed"
    )) as PausedOutput;
    const second = await agent.approveExecutionForTest(
      parked2.executionId ?? ""
    );

    expect(second).toBe("paused-exec: keyed");
    expect(await agent.getDurablePauseExecCount()).toBe(1);
  });

  it("sweeps abandoned pending rows past the TTL but keeps fresh ones", async () => {
    const agent = await freshPauseAgent(`dp-sweep-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const stale = (await agent.parkDurablePauseForTest(
      "stale"
    )) as PausedOutput;
    const fresh = (await agent.parkDurablePauseForTest(
      "fresh"
    )) as PausedOutput;

    await agent.setActionPendingApprovalTtlForTest(60_000);
    await agent.backdateActionPendingForTest(
      stale.executionId ?? "",
      Date.now() - 120_000
    );

    const { swept } = await agent.sweepActionPendingApprovalsForTest();
    expect(swept).toBe(1);

    const remaining = await agent.listActionPendingForTest();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].execution_id).toBe(fresh.executionId);
  });
});

describe("durable-pause actions (turn-driven, connection-less)", () => {
  it("attaches the descriptor to the paused part and continues with no open connection on approve", async () => {
    const agent = await freshPauseAgent(`dp-turn-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();

    // Drive a real (connection-less) turn: the model calls the durable-pause
    // action, which parks.
    const first = await agent.testChat("call pauseAction");
    expect(first.done).toBe(true);

    expect(await agent.getDurablePauseExecCount()).toBe(0);
    const pending = await agent.listActionPendingForTest();
    expect(pending).toHaveLength(1);
    const executionId = pending[0].execution_id;

    // The paused tool part carries the approval descriptor (single source);
    // the model-visible output stays minimal.
    const findPart = (messages: UIMessage[]) =>
      messages
        .flatMap((message) => message.parts)
        .find(
          (part) =>
            "toolCallId" in part &&
            (part as Record<string, unknown>).toolCallId === "dp1"
        ) as Record<string, unknown> | undefined;

    let messages = (await agent.getStoredMessages()) as UIMessage[];
    const pausedPart = findPart(messages);
    expect(pausedPart?.state).toBe("output-available");
    // The descriptor rides on a sibling field (not `part.approval`, which the
    // AI SDK reserves for live approval requests).
    expect(pausedPart?.approvalDescriptor).toMatchObject({
      action: "pauseAction",
      kind: "durable-pause",
      summary: "Approve pause action",
      risk: "high",
      permissions: ["pause:run"]
    });
    expect(pausedPart?.output).toMatchObject({ status: "paused" });
    expect(pausedPart?.output).not.toHaveProperty("permissions");

    const assistantTexts = (msgs: UIMessage[]) =>
      msgs
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(assistantTexts(messages)).not.toContain("acknowledged");

    // Approve with NO open connection → must still run + continue the model.
    const approved = await agent.approveExecutionForTest(executionId);
    expect(approved).toBe("paused-exec: hello");
    expect(await agent.getDurablePauseExecCount()).toBe(1);

    // Output replacement is applied synchronously within approve.
    messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(findPart(messages)?.output).toBe("paused-exec: hello");

    // The connection-independent continuation runs async (fire-and-forget):
    // wait for the model to produce new assistant text off the resolved result.
    await vi.waitFor(
      async () => {
        const latest = (await agent.getStoredMessages()) as UIMessage[];
        expect(assistantTexts(latest)).toContain("acknowledged");
      },
      { timeout: 5000, interval: 50 }
    );

    expect(await agent.listActionPendingForTest()).toHaveLength(0);
  });

  it("labels orphaned durable-pause outcomes without re-invoking the action", async () => {
    const agent = await freshPauseAgent(`dp-orphan-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();

    const first = await agent.testChat("call pauseAction");
    expect(first.done).toBe(true);

    const pending = await agent.listActionPendingForTest();
    expect(pending).toHaveLength(1);
    const executionId = pending[0].execution_id;
    await agent.stripDurablePausePartsForTest();

    const messagesBefore = (await agent.getStoredMessages()) as UIMessage[];
    const textPartsBefore = messagesBefore
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text").length;

    const rejected = (await agent.rejectExecutionForTest(
      executionId,
      "not now"
    )) as PausedOutput;
    expect(rejected.status).toBe("rejected");

    await vi.waitFor(
      async () => {
        const messages = (await agent.getStoredMessages()) as UIMessage[];
        const note = messages.find((message) =>
          message.id.startsWith(`exec-outcome-${executionId}-`)
        );
        const noteText = note?.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        expect(note?.role).toBe("system");
        expect(noteText).toContain("[durable action]");
        expect(noteText).not.toContain("[execute tool]");
        expect(noteText).toContain('"action":"pauseAction"');

        const textPartsAfter = messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text").length;
        expect(textPartsAfter).toBeGreaterThan(textPartsBefore);
        expect(await agent.listActionPendingForTest()).toHaveLength(0);
      },
      { timeout: 5000, interval: 50 }
    );
  });
});

describe("resolving a durable pause drops pending-state generation (#2054)", () => {
  const PENDING_REASONING = "reasoning:The action is waiting for approval.";
  const PENDING_TEXT = "text:Once approved, the change will be applied.";

  function ownerOf(messages: UIMessage[], toolCallId: string) {
    return messages.find(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) => "toolCallId" in part && part.toolCallId === toolCallId
        )
    );
  }

  /** `type:text` for each text/reasoning part after the tool call's part. */
  function generatedAfter(
    message: UIMessage | undefined,
    toolCallId: string
  ): string[] {
    const parts = message?.parts ?? [];
    const index = parts.findIndex(
      (part) => "toolCallId" in part && part.toolCallId === toolCallId
    );
    return parts
      .slice(index + 1)
      .flatMap((part) =>
        part.type === "text" || part.type === "reasoning"
          ? [`${part.type}:${part.text}`]
          : []
      );
  }

  function toolOutput(message: UIMessage | undefined, toolCallId: string) {
    const part = message?.parts.find(
      (p) => "toolCallId" in p && p.toolCallId === toolCallId
    ) as { output?: unknown } | undefined;
    return part?.output;
  }

  async function parkInTurn(name: string) {
    const agent = await freshPauseAgent(`${name}-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const first = await agent.testChat("call pauseAction");
    expect(first.done).toBe(true);
    const [pending] = await agent.listActionPendingForTest();
    return { agent, executionId: pending.execution_id };
  }

  async function continuationPrompt(
    agent: Awaited<ReturnType<typeof parkInTurn>>["agent"]
  ): Promise<string> {
    // Two model calls park the turn (tool call, then pending-state text);
    // the third is the continuation after the outcome.
    let prompts: string[] = [];
    await vi.waitFor(
      async () => {
        prompts = await agent.getDurablePausePromptsForTest();
        expect(prompts.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 5000, interval: 50 }
    );
    return prompts[2];
  }

  it("drops text and reasoning written after the paused part on approve", async () => {
    const { agent, executionId } = await parkInTurn("dp-stale-approve");
    const parked = ownerOf(
      (await agent.getStoredMessages()) as UIMessage[],
      "dp1"
    );
    expect(generatedAfter(parked, "dp1")).toEqual([
      PENDING_REASONING,
      PENDING_TEXT
    ]);

    await agent.approveExecutionForTest(executionId);

    const resolved = ownerOf(
      (await agent.getStoredMessages()) as UIMessage[],
      "dp1"
    );
    expect(resolved?.id).toBe(parked?.id);
    expect(toolOutput(resolved, "dp1")).toBe("paused-exec: hello");
    expect(generatedAfter(resolved, "dp1")).toEqual([]);

    const prompt = await continuationPrompt(agent);
    expect(prompt).toContain("paused-exec: hello");
    expect(prompt).not.toContain("Once approved");
    expect(prompt).not.toContain("waiting for approval");
  });

  it("drops text and reasoning written after the paused part on reject", async () => {
    const { agent, executionId } = await parkInTurn("dp-stale-reject");

    await agent.rejectExecutionForTest(executionId, "not now");

    const resolved = ownerOf(
      (await agent.getStoredMessages()) as UIMessage[],
      "dp1"
    );
    expect(toolOutput(resolved, "dp1")).toMatchObject({ status: "rejected" });
    expect(generatedAfter(resolved, "dp1")).toEqual([]);

    const prompt = await continuationPrompt(agent);
    expect(prompt).not.toContain("Once approved");
  });

  it("keeps earlier content and later non-generated parts", async () => {
    const agent = await freshPauseAgent(`dp-stale-keep-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    const toolCallId = "tc-seeded";
    const paused = (await agent.parkDurablePauseForTest(
      "hello",
      toolCallId
    )) as PausedOutput;
    await agent.appendMessagesForTest([
      {
        id: "u-seeded",
        role: "user",
        parts: [{ type: "text", text: "do the thing" }]
      },
      {
        id: "a-seeded",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Checking first." },
          {
            type: "tool-pauseAction",
            toolCallId,
            state: "output-available",
            input: { message: "hello" },
            output: paused
          },
          { type: "step-start" },
          { type: "reasoning", text: "Waiting on a human." },
          { type: "text", text: "Once approved, it runs." },
          {
            type: "tool-lookup",
            toolCallId: "tc-lookup",
            state: "output-available",
            input: {},
            output: "42"
          },
          { type: "file", mediaType: "text/plain", url: "data:,42" }
        ]
      } as UIMessage
    ]);

    await agent.approveExecutionForTest(paused.executionId as string);

    const resolved = ownerOf(
      (await agent.getStoredMessages()) as UIMessage[],
      toolCallId
    );
    expect(resolved?.parts.map((part) => part.type)).toEqual([
      "step-start",
      "text",
      "tool-pauseAction",
      "step-start",
      "tool-lookup",
      "file"
    ]);
    expect(resolved?.parts[1]).toMatchObject({ text: "Checking first." });
    expect(toolOutput(resolved, toolCallId)).toBe("paused-exec: hello");
    expect(toolOutput(resolved, "tc-lookup")).toBe("42");
  });

  it("drops the generation once the parking turn ends when approved mid-stream", async () => {
    const agent = await freshPauseAgent(`dp-stale-live-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    await agent.approveParkedInNextStepForTest();

    const first = await agent.testChat("call pauseAction");
    expect(first.done).toBe(true);

    const prompt = await continuationPrompt(agent);
    expect(prompt).toContain("paused-exec: hello");
    expect(prompt).not.toContain("Once approved");
    expect(prompt).not.toContain("waiting for approval");

    const resolved = ownerOf(
      (await agent.getStoredMessages()) as UIMessage[],
      "dp1"
    );
    expect(toolOutput(resolved, "dp1")).toBe("paused-exec: hello");
    expect(generatedAfter(resolved, "dp1")).toEqual([]);
  });

  async function approvedMidStreamWithoutContinuation(name: string) {
    const agent = await freshPauseAgent(`${name}-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest();
    await agent.holdConnectionlessContinuationForTest();
    await agent.approveParkedInNextStepForTest();
    const first = await agent.testChat("call pauseAction");
    expect(first.done).toBe(true);
    return agent;
  }

  it("drops the generation before a user turn that runs ahead of the continuation", async () => {
    const agent = await approvedMidStreamWithoutContinuation("dp-stale-user");

    await agent.testChat("what is the status?");

    const prompts = await agent.getDurablePausePromptsForTest();
    expect(prompts[2]).toContain("paused-exec: hello");
    expect(prompts[2]).not.toContain("Once approved");
    expect(prompts[2]).not.toContain("waiting for approval");
  });

  it("drops the generation after an eviction between the pause resolving and the next turn", async () => {
    const agent = await approvedMidStreamWithoutContinuation("dp-stale-evict");
    await agent.forgetDeferredResolvedPausesForTest();

    await agent.testChat("what is the status?");

    const prompts = await agent.getDurablePausePromptsForTest();
    expect(prompts[2]).not.toContain("Once approved");
    const resolved = ownerOf(
      (await agent.getStoredMessages()) as UIMessage[],
      "dp1"
    );
    expect(generatedAfter(resolved, "dp1")).toEqual([]);
  });
});

describe("paused-output descriptor derivation", () => {
  it("derives a codemode descriptor from pending[0]", async () => {
    const agent = await freshPauseAgent(`dp-codemode-${crypto.randomUUID()}`);
    const descriptor = (await agent.descriptorForPausedOutputForTest(
      "req-1",
      "tc-1",
      {
        status: "paused",
        executionId: "exec-123",
        pending: [
          {
            executionId: "exec-123",
            seq: 0,
            connector: "tools",
            method: "writeFile",
            args: { path: "/tmp/x" }
          }
        ]
      }
    )) as Record<string, unknown>;

    expect(descriptor.action).toBe("tools.writeFile");
    expect(descriptor.summary).toBe("tools.writeFile");
    expect(descriptor.input).toEqual({ path: "/tmp/x" });
    expect(descriptor.kind).toBe("durable-pause");
    expect(descriptor.requestId).toBe("req-1");
    expect(descriptor.toolCallId).toBe("tc-1");
  });

  it("lets describePausedExecution override codemode descriptor fields", async () => {
    const agent = await freshPauseAgent(`dp-override-${crypto.randomUUID()}`);
    await agent.setDescribePausedExecutionForTest({
      summary: "Write a file",
      permissions: ["fs:write"],
      risk: "medium"
    });

    const descriptor = (await agent.descriptorForPausedOutputForTest(
      "req-2",
      "tc-2",
      {
        status: "paused",
        executionId: "exec-456",
        pending: [
          {
            executionId: "exec-456",
            seq: 0,
            connector: "tools",
            method: "writeFile",
            args: { path: "/tmp/y" }
          }
        ]
      }
    )) as Record<string, unknown>;

    expect(descriptor.summary).toBe("Write a file");
    expect(descriptor.permissions).toEqual(["fs:write"]);
    expect(descriptor.risk).toBe("medium");
    // Identity fields stay ours even with an override.
    expect(descriptor.requestId).toBe("req-2");
    expect(descriptor.toolCallId).toBe("tc-2");
  });

  it("returns undefined for non-paused output", async () => {
    const agent = await freshPauseAgent(`dp-nonpaused-${crypto.randomUUID()}`);
    const descriptor = await agent.descriptorForPausedOutputForTest("r", "t", {
      status: "completed"
    });
    expect(descriptor).toBeUndefined();
  });
});

describe("action() durable-pause validation", () => {
  it("rejects kind durable-pause with approval: false", () => {
    expect(() =>
      action({
        name: "bad",
        description: "invalid",
        inputSchema: z.object({ message: z.string() }),
        kind: "durable-pause",
        approval: false,
        execute: async () => "x"
      })
    ).toThrow(/durable-pause.*approval: false/s);
  });

  it("allows kind durable-pause without an approval policy", () => {
    expect(() =>
      action({
        name: "ok",
        description: "valid",
        inputSchema: z.object({ message: z.string() }),
        kind: "durable-pause",
        execute: async () => "x"
      })
    ).not.toThrow();
  });
});
