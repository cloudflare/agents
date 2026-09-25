/**
 * #2280: terminal chat frames echo the user message ids the request carried,
 * so a client can settle exactly the sends a completion or error belongs to.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type {
  ThinkRecoveryTestAgent,
  ThinkTestAgent
} from "./agents/think-session";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

type TerminalFrame = {
  id: string;
  done?: boolean;
  error?: boolean;
  messageIds?: string[];
};

async function freshAgent() {
  const room = crypto.randomUUID();
  const agent = await getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    room
  );
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { agent, ws };
}

function user(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function sendAndWaitForDone(
  ws: WebSocket,
  requestId: string,
  messages: UIMessage[]
): Promise<TerminalFrame[]> {
  return new Promise((resolve, reject) => {
    const terminals: TerminalFrame[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      10_000
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as TerminalFrame & {
        type?: string;
      };
      if (msg.type !== MSG_CHAT_RESPONSE || msg.id !== requestId) return;
      if (msg.done || msg.error) terminals.push(msg);
      if (msg.done) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(terminals);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: requestId,
        init: { method: "POST", body: JSON.stringify({ messages }) }
      })
    );
  });
}

describe("Think terminal frames carry originating message ids (#2280)", () => {
  it("echoes the request's user message id on the done frame", async () => {
    const { ws } = await freshAgent();
    const terminals = await sendAndWaitForDone(ws, "req-1", [user("msg-1")]);
    expect(terminals.at(-1)?.messageIds).toEqual(["msg-1"]);
    ws.close();
  });

  it("echoes every trailing user message of the request", async () => {
    const { ws } = await freshAgent();
    const terminals = await sendAndWaitForDone(ws, "req-2", [
      user("msg-a"),
      user("msg-b")
    ]);
    expect(terminals.at(-1)?.messageIds).toEqual(["msg-a", "msg-b"]);
    ws.close();
  });

  it("carries the ids onto a recovered turn's successor request", async () => {
    const { agent, ws } = await freshAgent();
    const successorTerminals: TerminalFrame[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as TerminalFrame & {
        type?: string;
      };
      if (
        msg.type === MSG_CHAT_RESPONSE &&
        msg.id !== "req-stall" &&
        msg.done
      ) {
        successorTerminals.push(msg);
      }
    });

    await agent.armStallOnceForTest(1, 50);
    const first = await sendAndWaitForDone(ws, "req-stall", [user("msg-s")]);
    expect(first.at(-1)?.messageIds).toEqual(["msg-s"]);

    for (let i = 0; i < 50 && successorTerminals.length === 0; i++) {
      await agent.runStallContinuationForTest();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(successorTerminals.length).toBeGreaterThan(0);
    for (const frame of successorTerminals) {
      expect(frame.messageIds).toEqual(["msg-s"]);
    }
    ws.close();
  });

  it("echoes the ids on the error terminal and in the durable terminal record", async () => {
    const { agent, ws } = await freshAgent();
    await agent.setInBandErrorResponse("provider exploded");
    const terminals = await sendAndWaitForDone(ws, "req-3", [user("msg-e")]);
    expect(terminals.some((frame) => frame.error)).toBe(true);
    for (const frame of terminals) {
      expect(frame.messageIds).toEqual(["msg-e"]);
    }
    const pending = (await agent.getPendingChatTerminalForTest()) as {
      requestId: string;
      messageIds?: string[];
    } | null;
    expect(pending).toMatchObject({
      requestId: "req-3",
      messageIds: ["msg-e"]
    });
    ws.close();
  });

  it("carries the ids onto a turn recovered before its stream started", async () => {
    const room = crypto.randomUUID();
    const agent = (await getAgentByName(
      env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
      room
    )) as unknown as {
      persistTestMessage(msg: UIMessage): Promise<void>;
      insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
      triggerFiberRecovery(): Promise<unknown>;
      runScheduledRecoveryRetryForTest(): Promise<void>;
    };
    await agent.persistTestMessage(user("msg-p"));
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-pre", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-pre",
        continuation: false,
        latestMessageId: "msg-p",
        latestMessageRole: "user",
        latestUserMessageId: "msg-p",
        startedAt: Date.now(),
        originMessageIds: ["msg-p"]
      },
      user: null
    });
    const res = await exports.default.fetch(
      `http://example.com/agents/think-recovery-test-agent/${room}`,
      { headers: { Upgrade: "websocket" } }
    );
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const terminals: TerminalFrame[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as TerminalFrame & {
        type?: string;
      };
      if (msg.type === MSG_CHAT_RESPONSE && msg.done) terminals.push(msg);
    });

    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryRetryForTest();
    for (let i = 0; i < 60 && terminals.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(terminals.length).toBeGreaterThan(0);
    for (const frame of terminals) {
      expect(frame.messageIds).toEqual(["msg-p"]);
    }
    ws.close();
  });

  it("carries the ids onto a pre-stream turn that exhausts on wake", async () => {
    const room = crypto.randomUUID();
    const agent = (await getAgentByName(
      env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
      room
    )) as unknown as {
      enableExhaustedCaptureForTest(maxAttempts: number): Promise<void>;
      persistTestMessage(msg: UIMessage): Promise<void>;
      insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
      seedIncidentForTest(incident: Record<string, unknown>): Promise<void>;
      readProgressMarkerForTest(): Promise<number>;
      triggerFiberRecovery(): Promise<unknown>;
      getPendingChatTerminalForTest(): Promise<{
        requestId: string;
        messageIds?: string[];
      } | null>;
    };
    await agent.enableExhaustedCaptureForTest(1);
    await agent.persistTestMessage(user("msg-x"));
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-x", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-x",
        continuation: false,
        latestMessageId: "msg-x",
        latestMessageRole: "user",
        latestUserMessageId: "msg-x",
        startedAt: Date.now(),
        originMessageIds: ["msg-x"]
      },
      user: null
    });
    await agent.seedIncidentForTest({
      incidentId: "req-x:msg-x",
      requestId: "req-x",
      recoveryKind: "retry",
      attempt: 1,
      maxAttempts: 1,
      status: "scheduled",
      firstSeenAt: Date.now() - 60_000,
      lastAttemptAt: Date.now() - 60_000,
      progress: await agent.readProgressMarkerForTest()
    });
    const res = await exports.default.fetch(
      `http://example.com/agents/think-recovery-test-agent/${room}`,
      { headers: { Upgrade: "websocket" } }
    );
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const errors: TerminalFrame[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as TerminalFrame & {
        type?: string;
      };
      if (msg.type === MSG_CHAT_RESPONSE && msg.id === "req-x" && msg.error) {
        errors.push(msg);
      }
    });

    await agent.triggerFiberRecovery();
    for (let i = 0; i < 60 && errors.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errors.length).toBeGreaterThan(0);
    for (const frame of errors) {
      expect(frame.messageIds).toEqual(["msg-x"]);
    }
    expect(await agent.getPendingChatTerminalForTest()).toMatchObject({
      requestId: "req-x",
      messageIds: ["msg-x"]
    });
    ws.close();
  });
});
