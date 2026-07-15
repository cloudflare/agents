import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel } from "../adapters/memory/fake-model.js";
import { createMemoryConnectionRegistry } from "../adapters/memory/transport.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient } from "../ports/model.js";
import {
  action,
  type Action,
  type ActionTurnContext,
  type AuthorizationDecision,
  type ReplyAttachment,
} from "../domain/actions/actions.js";
import type { ConversationEvent, StoredEvent } from "../domain/events/log.js";
import type { AgentHost } from "../app/agent.js";
import { Think, type ChatResponseResult } from "../app/think.js";
import { attachChatTransport } from "../adapters/websocket-chat/adapter.js";
import { connectChatClient } from "../adapters/websocket-chat/test-helpers.js";

/**
 * Scenario 5 (audit 24 §5): the HITL (human-in-the-loop) path — idempotent
 * ledger replay, inline approval, durable-pause parking, per-turn
 * authorization, and reply attachments, through the public Think API.
 *
 * Wave R3: the two approval-path cases (inline approval-gated tool +
 * durable-pause) are rewired to run through `attachChatTransport` +
 * `connectChatClient`, so both branches of the inbound `cf_agent_tool_approval`
 * frame (`toolCallId` for an in-turn suspension, `executionId` for a parked
 * durable-pause) are exercised at the frame level — frame -> `resolveApproval`
 * -> pipeline -> log -> frame. The ledger-replay, authorization-denial, and
 * reply-attachment cases aren't approval paths in that sense and stay
 * method/event-driven, as R2 left them.
 */

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

function eventsOfType<T extends ConversationEvent["type"]>(
  events: StoredEvent[],
  type: T,
): Array<Extract<ConversationEvent, { type: T }>> {
  return events.map((e) => e.event).filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
}

function framesOfType(frames: unknown[], type: string): Array<Record<string, unknown>> {
  return frames.filter(
    (f): f is Record<string, unknown> => typeof f === "object" && f !== null && (f as { type?: unknown }).type === type,
  );
}

function userMessage(id: string, text: string): { id: string; role: "user"; parts: Array<{ type: "text"; text: string }> } {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function chatRequest(id: string, text: string): Record<string, unknown> {
  return {
    type: "cf_agent_use_chat_request",
    id,
    init: { method: "POST", body: JSON.stringify({ messages: [userMessage(`u_${id}`, text)] }) },
  };
}

function chunkBody(frame: Record<string, unknown>): { type: string } & Record<string, unknown> {
  if (typeof frame.body !== "string") throw new Error("response frame missing body");
  return JSON.parse(frame.body) as { type: string } & Record<string, unknown>;
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

  it("approval-gated delete_account over the WS chat transport: a cf_agent_tool_approval(toolCallId) frame approves once; a separate reject settles as output-denied without executing", async () => {
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "delete_account", input: { confirm: true }, id: "call_1" },
      { kind: "text", text: "Account deleted." },
    ]);
    await agent.start();
    const events: StoredEvent[] = [];
    agent.events().subscribe("live", (e) => events.push(e));

    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send(chatRequest("req_1", "delete my account"));

    await vi.waitFor(() => {
      const approvalRequested = framesOfType(client.frames, "cf_agent_use_chat_response")
        .filter((f) => f.done === false)
        .map(chunkBody)
        .find((c) => c.type === "tool-approval-requested");
      expect(approvalRequested).toBeDefined();
    });
    const approvalRequested = eventsOfType(events, "chunk")
      .map((e) => e.chunk)
      .find((c) => c.type === "tool-approval-requested");
    expect(approvalRequested).toBeDefined();

    await client.send({ type: "cf_agent_tool_approval", toolCallId: "call_1", approved: true });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Account deleted."))).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        framesOfType(client.frames, "cf_agent_use_chat_response").some((f) => f.done === true && f.body === undefined),
      ).toBe(true);
      expect(
        framesOfType(client.frames, "cf_agent_chat_messages").some(
          (f) => Array.isArray(f.messages) && f.messages.length >= 2,
        ),
      ).toBe(true);
    });
    expect(agent.actionExecuteCounts.delete_account).toBe(1);
    expect(
      framesOfType(client.frames, "cf_agent_message_updated").some((f) =>
        (f.message as { parts: Array<{ type: string; text?: string }> }).parts.some(
          (p) => p.type === "text" && p.text === "Account deleted.",
        ),
      ),
    ).toBe(true);

    // A fresh turn, rejected this time via the frame: settles as output-denied (ISSUE-029), never executes.
    const { agent: agent2 } = makeAgent();
    agent2.model = createFakeModel([
      { kind: "tool-call", toolName: "delete_account", input: { confirm: true }, id: "call_r" },
      { kind: "text", text: "Okay, not deleting." },
    ]);
    await agent2.start();
    const registry2 = createMemoryConnectionRegistry();
    const transport2 = attachChatTransport(agent2, registry2);
    const client2 = await connectChatClient(transport2, registry2);

    await client2.send(chatRequest("req_2", "delete my account"));
    await vi.waitFor(() => {
      expect(
        framesOfType(client2.frames, "cf_agent_use_chat_response").some(
          (f) => f.done === false && chunkBody(f).type === "tool-approval-requested",
        ),
      ).toBe(true);
    });
    await client2.send({
      type: "cf_agent_tool_approval",
      toolCallId: "call_r",
      approved: false,
      reason: "changed my mind",
    });

    await vi.waitFor(async () => {
      const messages = await agent2.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Okay, not deleting."))).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        framesOfType(client2.frames, "cf_agent_use_chat_response").some((f) => f.done === true && f.body === undefined),
      ).toBe(true);
      expect(
        framesOfType(client2.frames, "cf_agent_chat_messages").some(
          (f) => Array.isArray(f.messages) && f.messages.length >= 2,
        ),
      ).toBe(true);
    });
    const messages2 = await agent2.getMessages();
    const toolPart = messages2[1]!.parts.find((p) => p.type === "tool-delete_account");
    expect(toolPart).toMatchObject({ state: "output-denied" });
    expect((toolPart as { errorText: string }).errorText).toContain("changed my mind");
    expect(agent2.actionExecuteCounts.delete_account ?? 0).toBe(0);
  });

  it("durable-pause deploy over the WS chat transport: parks, ends the turn, and a cf_agent_tool_approval(executionId) frame runs it once, writes output, and auto-continues", async () => {
    const { agent } = makeAgent();
    agent.authorizeTurn = (): AuthorizationDecision => ({ allowed: true, grantedPermissions: ["ops:deploy"] });
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "deploy", input: { env: "prod" }, id: "call_1" },
      { kind: "text", text: "Deployed to prod!" },
    ]);
    await agent.start();

    const registry = createMemoryConnectionRegistry();
    const transport = attachChatTransport(agent, registry);
    const client = await connectChatClient(transport, registry);

    await client.send(chatRequest("req_1", "deploy to prod"));

    await vi.waitFor(() => {
      expect(agent.pendingApprovals()).toHaveLength(1); // durable-pause ends the turn
    });

    const pending = agent.pendingApprovals();
    expect(pending[0]!.descriptor).toMatchObject({ action: "deploy", kind: "durable-pause", permissions: ["ops:deploy"] });

    await client.send({ type: "cf_agent_tool_approval", executionId: pending[0]!.executionId, approved: true });

    await vi.waitFor(async () => {
      const messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Deployed to prod!"))).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        framesOfType(client.frames, "cf_agent_use_chat_response").some((f) => f.done === true && f.body === undefined),
      ).toBe(true);
      expect(
        framesOfType(client.frames, "cf_agent_chat_messages").some(
          (f) => Array.isArray(f.messages) && f.messages.length >= 2,
        ),
      ).toBe(true);
    });
    expect(agent.actionExecuteCounts.deploy).toBe(1);
    const messages = await agent.getMessages();
    const deployPart = messages.flatMap((m) => m.parts).find((p) => p.type === "tool-deploy");
    expect(deployPart).toMatchObject({ state: "output-available", output: { deployed: "prod" } });

    // Idempotent: a second approval frame for the same execution is a no-op (no re-execute).
    await client.send({ type: "cf_agent_tool_approval", executionId: pending[0]!.executionId, approved: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.actionExecuteCounts.deploy).toBe(1);
  });

  it("an action outside the turn's granted permissions returns an ActionAuthorizationError value to the model, not a thrown error", async () => {
    const { agent } = makeAgent();
    agent.authorizeTurn = (_ctx: ActionTurnContext): AuthorizationDecision => ({
      allowed: true,
      grantedPermissions: ["something:else"], // does not include "billing:charge"
    });
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "charge", input: { orderId: "order-9", amount: 5 }, id: "call_1" },
      { kind: "text", text: "Sorry, I couldn't charge that order." },
    ]);
    await agent.start();

    await agent.chat("charge order-9", undefined, { requestId: "req_1" });

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
    const { agent } = makeAgent();
    agent.model = createFakeModel([
      { kind: "tool-call", toolName: "charge", input: { orderId: "order-2", amount: 17 }, id: "call_1" },
      { kind: "text", text: "Charged order-2." },
    ]);
    await agent.start();

    await agent.chat("charge order-2", undefined, { requestId: "req_1" });

    // The onChatResponse snapshot is the durable read of a turn's
    // attachments: `clearTurn()` (called right after) drops the per-turn
    // buffer `replyAttachments()` reads from, by design (audit 12 "Parked
    // executions API" — attachment state is per-turn, not retained history).
    expect(agent.lastOnChatResponse?.attachments).toEqual([
      { type: "receipt", orderId: "order-2", amount: 17 } satisfies ReplyAttachment,
    ]);
  });
});
