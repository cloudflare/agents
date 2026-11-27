import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../think";

type ActionsStub = {
  say(text: string): Promise<void>;
  charged(): Promise<number>;
  toolStates(): Promise<string[]>;
  lastText(): Promise<string>;
  resetForTest(): Promise<void>;
  grantForTest(permissions: string[] | undefined): Promise<void>;
  toolOutputs(): Promise<unknown[]>;
  rewriteForTest(amount: number): Promise<void>;
  pendingApprovals(executionId?: string): Promise<PendingApproval[]>;
  approveExecution(executionId: string): Promise<unknown>;
  rejectExecution(
    executionId: string,
    reason?: string,
    options?: { autoContinue?: boolean }
  ): Promise<unknown>;
};

async function agent(name = crypto.randomUUID()): Promise<ActionsStub> {
  return (await getAgentByName(
    env.ThinkHarnessActionsAgent,
    name
  )) as unknown as ActionsStub;
}

describe("harness-backed Think: actions that need a human", () => {
  it("lists an approval-gated call with its descriptor, and runs it once on approve", async () => {
    const think = await agent();
    await think.say("charge 5");
    expect(await think.charged()).toBe(0);
    expect(await think.toolStates()).toEqual(["approval-requested"]);

    const pending = await think.pendingApprovals();
    expect(pending).toEqual([
      {
        executionId: expect.any(String),
        source: "action",
        descriptor: expect.objectContaining({
          toolCallId: "call-1",
          action: "charge",
          summary: "Charge the customer's card",
          input: { amount: 5 },
          permissions: ["billing:charge"],
          risk: "high",
          kind: "approval-gated"
        })
      }
    ]);

    // As on Think: approving answers the action's outcome.
    expect(await think.approveExecution(pending[0].executionId)).toEqual({
      charged: 5
    });
    expect(await think.charged()).toBe(1);
    expect(await think.toolStates()).toEqual(["output-available"]);
    expect(await think.lastText()).toContain("charged");
    expect(await think.pendingApprovals()).toEqual([]);

    // Deciding it again finds nothing to decide, and runs nothing.
    expect(await think.approveExecution(pending[0].executionId)).toMatchObject({
      status: "error"
    });
    expect(await think.charged()).toBe(1);
  });

  it("parks a durable-pause call for approval, and reports a rejection without running it", async () => {
    const think = await agent();
    await think.say("pause and charge 5");
    const [pending] = await think.pendingApprovals();
    expect(pending.descriptor).toMatchObject({
      action: "pauseCharge",
      summary: "Charge the card after a human approves",
      kind: "durable-pause"
    });

    expect(
      await think.rejectExecution(pending.executionId, "too much")
    ).toEqual({
      status: "rejected",
      executionId: pending.executionId,
      reason: "too much"
    });
    expect(await think.charged()).toBe(0);
    expect(await think.toolStates()).toEqual(["output-denied"]);
    expect(await think.pendingApprovals()).toEqual([]);
  });

  it("lists the same descriptor after a restart, from the action and its input", async () => {
    const name = crypto.randomUUID();
    const think = await agent(name);
    await think.say("charge 5");
    const [before] = await think.pendingApprovals();
    // A fresh isolate has no descriptors in memory: listing computes them.
    await think.resetForTest().catch(() => {});
    const fresh = await agent(name);
    const [after] = await fresh.pendingApprovals();
    // The same, except the asking turn's id, which only memory knew.
    expect(before.descriptor.requestId).not.toBe("");
    expect({
      ...after,
      descriptor: { ...after.descriptor, requestId: "" }
    }).toEqual({
      ...before,
      descriptor: { ...before.descriptor, requestId: "" }
    });
    await fresh.approveExecution(after.executionId);
    expect(await fresh.charged()).toBe(1);
  });

  it("refuses an action whose permission the turn was not granted, without asking", async () => {
    const think = await agent();
    await think.grantForTest([]);
    await think.say("charge 5");
    expect(await think.pendingApprovals()).toEqual([]);
    expect(await think.charged()).toBe(0);
    expect(await think.toolOutputs()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          name: "ActionAuthorizationError",
          permissions: ["billing:charge"]
        })
      })
    ]);
  });

  it("asks the turn's grant again for a call approved after a restart", async () => {
    const name = crypto.randomUUID();
    const think = await agent(name);
    await think.say("charge 5");
    const [pending] = await think.pendingApprovals();
    // The grant is withdrawn while the call waits, then the object restarts.
    await think.grantForTest([]);
    await think.resetForTest().catch(() => {});
    const fresh = await agent(name);
    await fresh.approveExecution(pending.executionId);
    expect(await fresh.charged()).toBe(0);
    expect(await fresh.toolOutputs()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ name: "ActionAuthorizationError" })
      })
    ]);
  });

  it("does not run an approved action whose input beforeToolCall changed", async () => {
    const think = await agent();
    await think.say("charge 5");
    const [pending] = await think.pendingApprovals();
    await think.rewriteForTest(500);
    await think.approveExecution(pending.executionId);
    expect(await think.charged()).toBe(0);
    expect(await think.toolOutputs()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ name: "ActionApprovalInputError" })
      })
    ]);
  });

  it("lists permissions computed from the input, also after a restart", async () => {
    const name = crypto.randomUUID();
    const think = await agent(name);
    await think.say("pause and charge 5");
    const [before] = await think.pendingApprovals();
    expect(before.descriptor.permissions).toEqual(["billing:charge:5"]);
    await think.resetForTest().catch(() => {});
    const [after] = await (await agent(name)).pendingApprovals();
    expect(after.descriptor.permissions).toEqual(["billing:charge:5"]);
  });

  it("answers the approval methods over a tab's RPC", async () => {
    const name = crypto.randomUUID();
    const think = await agent(name);
    await think.say("charge 5");
    const res = await exports.default.fetch(
      `http://example.com/agents/think-harness-actions-agent/${name}`,
      { headers: { Upgrade: "websocket" } }
    );
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const call = (method: string, args: unknown[]) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = crypto.randomUUID();
        ws.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as Record<
            string,
            unknown
          >;
          if (frame.type === "rpc" && frame.id === id) resolve(frame);
        });
        ws.send(JSON.stringify({ type: "rpc", id, method, args }));
      });
    const listed = await call("pendingApprovals", []);
    expect(listed.success).toBe(true);
    const [pending] = listed.result as PendingApproval[];
    const approved = await call("approveExecution", [pending.executionId]);
    expect(approved).toMatchObject({ success: true, result: { charged: 5 } });
    ws.close();
  });
});
