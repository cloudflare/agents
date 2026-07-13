import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryConnection, type MemoryConnection } from "../adapters/memory/transport.js";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient } from "../ports/model.js";
import {
  action,
  type Action,
  type ActionTurnContext,
  type AuthorizationDecision,
  type ReplyAttachment,
} from "../domain/actions/actions.js";
import type { AgentHost } from "../app/agent.js";
import { Think, type ChatResponseResult } from "../app/think.js";

/**
 * Scenario 5 (audit 24 §5): the HITL (human-in-the-loop) path — idempotent
 * ledger replay, inline approval, durable-pause parking, per-turn
 * authorization, and reply attachments, all through the public Think API.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    connections: mem.connections,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

function framesOfType(conn: MemoryConnection, type: string): Array<Record<string, unknown>> {
  return conn.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.type === type);
}

class ActionsThink extends Think<unknown> {
  model!: ModelClient;
  actionExecuteCounts: Record<string, number> = {};
  lastOnChatResponse: ChatResponseResult | undefined;

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getActions(): Record<string, Action> {
    return {
      charge: action({
        description: "Charges a customer's card for an order",
        inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
        // "explicit key": derived from input, not the toolCallId fallback —
        // two separate tool calls for the same order replay one ledger row.
        idempotencyKey: (args: { input: { orderId: string; amount: number } }) => `charge:${args.input.orderId}`,
        permissions: ["billing:charge"],
        execute: (input: { orderId: string; amount: number }, ctx) => {
          this.actionExecuteCounts.charge = (this.actionExecuteCounts.charge ?? 0) + 1;
          ctx.attachReply({ type: "receipt", orderId: input.orderId, amount: input.amount });
          return { charged: input.amount, orderId: input.orderId };
        },
      }),
      delete_account: action({
        description: "Permanently deletes the user's account",
        inputSchema: z.object({ confirm: z.boolean() }),
        approval: true,
        approvalRisk: "high",
        execute: (input: { confirm: boolean }) => {
          this.actionExecuteCounts.delete_account = (this.actionExecuteCounts.delete_account ?? 0) + 1;
          return { deleted: input.confirm };
        },
      }),
      deploy: action({
        description: "Deploys to production",
        inputSchema: z.object({ env: z.string() }),
        kind: "durable-pause",
        approval: true,
        permissions: ["ops:deploy"],
        execute: (input: { env: string }) => {
          this.actionExecuteCounts.deploy = (this.actionExecuteCounts.deploy ?? 0) + 1;
          return { deployed: input.env };
        },
      }),
    };
  }

  override onChatResponse = async (result: ChatResponseResult): Promise<void> => {
    this.lastOnChatResponse = result;
  };
}

function makeAgent(): { agent: ActionsThink; mem: MemoryHost } {
  const mem = createMemoryHost({ agent: "ActionsThink", name: "a1" });
  const host = toHost(mem, { className: "ActionsThink", name: "a1" });
  const agent = new ActionsThink(host);
  mem.attachAgent(agent);
  agent.chatToolResultDebounceMs = 0;
  return { agent, mem };
}

describe("e2e: actions and approvals", () => {
  it("idempotent charge: a duplicate call under the same explicit key replays the ledgered output instead of re-executing", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "charge", input: { orderId: "order-1", amount: 42 }, id: "call_1" },
      { kind: "text", text: "Charged order-1." },
      { kind: "tool-call", toolName: "charge", input: { orderId: "order-1", amount: 42 }, id: "call_2" },
      { kind: "text", text: "Already charged order-1." },
    ]);
    await agent.start();

    const first = await agent.chat("charge order-1 for $42", undefined, { requestId: "req_1" });
    const second = await agent.chat("charge order-1 again", undefined, { requestId: "req_2" });

    expect(first.outcome).toBe("completed");
    expect(second.outcome).toBe("completed");
    expect(agent.actionExecuteCounts.charge).toBe(1); // ledger replay, not a re-run

    const messages = await agent.getMessages();
    const secondTurnCharge = messages[3]!.parts.find((p) => p.type === "tool-charge");
    expect(secondTurnCharge).toMatchObject({ state: "output-available", output: { charged: 42, orderId: "order-1" } });
  });

  it("approval-gated delete_account: approve executes once; a separate reject settles as output-error without executing", async () => {
    const { agent, mem } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "delete_account", input: { confirm: true }, id: "call_1" },
      { kind: "text", text: "Account deleted." },
    ]);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);

    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "delete my account" }),
    );

    const approvalFrame = framesOfType(conn, "cf_agent_use_chat_response").find(
      (f) => (f.chunk as { type: string }).type === "tool-approval-requested",
    );
    expect(approvalFrame).toBeDefined();

    await agent.onMessage(conn, JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: "call_1", approved: true }));

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Account deleted."))).toBe(true);
    });
    expect(agent.actionExecuteCounts.delete_account).toBe(1);

    // A fresh turn, rejected this time: settles as output-error, never executes.
    const { agent: agent2, mem: mem2 } = makeAgent();
    agent2.model = createFakeModel([
      { kind: "tool-call", toolName: "delete_account", input: { confirm: true }, id: "call_r" },
      { kind: "text", text: "Okay, not deleting." },
    ]);
    await agent2.start();
    const conn2 = createMemoryConnection("c2");
    mem2.connections.add(conn2);
    await agent2.onMessage(
      conn2,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_2", input: "delete my account" }),
    );
    await agent2.onMessage(
      conn2,
      JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: "call_r", approved: false, reason: "changed my mind" }),
    );
    await vi.waitFor(async () => {
      const messages = await agent2.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Okay, not deleting."))).toBe(true);
    });
    const messages2 = await agent2.getMessages();
    const toolPart = messages2[1]!.parts.find((p) => p.type === "tool-delete_account");
    expect(toolPart).toMatchObject({ state: "output-error" });
    expect((toolPart as { errorText: string }).errorText).toContain("changed my mind");
    expect(agent2.actionExecuteCounts.delete_account ?? 0).toBe(0);
  });

  it("durable-pause deploy: parks, ends the turn, and approveExecution runs once, writes output, and auto-continues", async () => {
    const { agent, mem } = makeAgent();
    agent.authorizeTurn = (): AuthorizationDecision => ({ allowed: true, grantedPermissions: ["ops:deploy"] });
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "deploy", input: { env: "prod" }, id: "call_1" },
      { kind: "text", text: "Deployed to prod!" },
    ]);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);

    const result = await agent.chat("deploy to prod", undefined, { requestId: "req_1" });
    expect(result.outcome).toBe("suspended"); // durable-pause ends the turn

    const pending = agent.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.descriptor).toMatchObject({ action: "deploy", kind: "durable-pause", permissions: ["ops:deploy"] });

    const output = await agent.approveExecution(pending[0]!.executionId);
    expect(output).toEqual({ deployed: "prod" });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Deployed to prod!"))).toBe(true);
    });
    expect(agent.actionExecuteCounts.deploy).toBe(1);

    // Idempotent: a second approve on the same execution is a no-op (no re-execute).
    const secondOutput = await agent.approveExecution(pending[0]!.executionId);
    expect(secondOutput).toEqual({ deployed: "prod" });
    expect(agent.actionExecuteCounts.deploy).toBe(1);
  });

  it("an action outside the turn's granted permissions returns an ActionAuthorizationError value to the model, not a thrown error", async () => {
    const { agent, mem } = makeAgent();
    agent.authorizeTurn = (_ctx: ActionTurnContext): AuthorizationDecision => ({
      allowed: true,
      grantedPermissions: ["something:else"], // does not include "billing:charge"
    });
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "charge", input: { orderId: "order-9", amount: 5 }, id: "call_1" },
      { kind: "text", text: "Sorry, I couldn't charge that order." },
    ]);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);

    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "charge order-9" }),
    );

    expect(agent.actionExecuteCounts.charge ?? 0).toBe(0);
    const messages = await agent.getMessages();
    const toolPart = messages[1]!.parts.find((p) => p.type === "tool-charge") as
      | { state: string; output: { error: { name: string; permissions: string[] } } }
      | undefined;
    expect(toolPart?.state).toBe("output-available"); // a value-level failure, not a protocol error
    expect(toolPart?.output.error.name).toBe("ActionAuthorizationError");
    expect(toolPart?.output.error.permissions).toEqual(["billing:charge"]);
    expect(messages[1]!.parts.find((p) => p.type === "text")).toMatchObject({
      text: "Sorry, I couldn't charge that order.",
    });
  });

  it("reply attachments surface in onChatResponse", async () => {
    const { agent, mem } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "charge", input: { orderId: "order-2", amount: 17 }, id: "call_1" },
      { kind: "text", text: "Charged order-2." },
    ]);
    await agent.start();
    const conn = createMemoryConnection("c1");
    mem.connections.add(conn);

    await agent.onMessage(
      conn,
      JSON.stringify({ type: "cf_agent_use_chat_request", id: "req_1", input: "charge order-2" }),
    );

    // The onChatResponse snapshot is the durable read of a turn's
    // attachments: `clearTurn()` (called right after) drops the per-turn
    // buffer `replyAttachments()` reads from, by design (audit 12 "Parked
    // executions API" — attachment state is per-turn, not retained history).
    expect(agent.lastOnChatResponse?.attachments).toEqual([
      { type: "receipt", orderId: "order-2", amount: 17 } satisfies ReplyAttachment,
    ]);
  });
});
