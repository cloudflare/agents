import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

type ResponseFrame = {
  type: string;
  id: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  messageIds?: string[];
};

function user(id: string): ChatMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function waitForTerminal(
  ws: WebSocket,
  requestId: string,
  predicate: (frame: ResponseFrame) => boolean = () => true
): Promise<ResponseFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`no terminal frame for ${requestId}`)),
      3000
    );
    const handler = (e: MessageEvent) => {
      const frame = JSON.parse(e.data as string) as ResponseFrame;
      if (
        frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        frame.id === requestId &&
        frame.done &&
        predicate(frame)
      ) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(frame);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function sendChat(ws: WebSocket, requestId: string, messages: ChatMessage[]) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: { method: "POST", body: JSON.stringify({ messages }) }
    })
  );
}

describe("originating message ids on terminal frames (#2280)", () => {
  it("echoes the request's user message id on the live done frame", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const done = waitForTerminal(ws, "req-a");
    sendChat(ws, "req-a", [user("msg-a")]);
    expect((await done).messageIds).toEqual(["msg-a"]);

    ws.close(1000);
  });

  it("echoes every trailing user message of the request", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const done = waitForTerminal(ws, "req-b");
    sendChat(ws, "req-b", [user("msg-1"), user("msg-2")]);
    expect((await done).messageIds).toEqual(["msg-1", "msg-2"]);

    ws.close(1000);
  });

  it("carries the ids onto a recovered turn's successor request", async () => {
    const room = crypto.randomUUID();
    const agent = await getAgentByName(env.ChatRecoveryTestAgent, room);
    await (
      agent as unknown as {
        armStallingTurnsForTest(timeoutMs: number, hangTurns: number): void;
      }
    ).armStallingTurnsForTest(150, 1);
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    const successorTerminals: ResponseFrame[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(e.data as string) as ResponseFrame;
      if (
        frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        frame.id !== "req-stall" &&
        frame.done
      ) {
        successorTerminals.push(frame);
      }
    });

    const first = waitForTerminal(ws, "req-stall");
    sendChat(ws, "req-stall", [user("msg-s")]);
    expect((await first).messageIds).toEqual(["msg-s"]);

    for (let i = 0; i < 60 && successorTerminals.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(successorTerminals.length).toBeGreaterThan(0);
    for (const frame of successorTerminals) {
      expect(frame.messageIds).toEqual(["msg-s"]);
    }

    ws.close(1000);
  });

  it("carries the ids onto a turn re-run after its reader failed before any part", async () => {
    const room = crypto.randomUUID();
    const agent = await getAgentByName(env.ChatRecoveryTestAgent, room);
    await (
      agent as unknown as {
        armFailingReaderTurnForTest(message: string, prelude: "none"): void;
      }
    ).armFailingReaderTurnForTest("Network connection lost.", "none");
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    const successorTerminals: ResponseFrame[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(e.data as string) as ResponseFrame;
      if (
        frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        frame.id !== "req-drop" &&
        frame.done
      ) {
        successorTerminals.push(frame);
      }
    });

    const first = waitForTerminal(ws, "req-drop");
    sendChat(ws, "req-drop", [user("msg-r")]);
    expect((await first).messageIds).toEqual(["msg-r"]);

    for (let i = 0; i < 100 && successorTerminals.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(successorTerminals.length).toBeGreaterThan(0);
    for (const frame of successorTerminals) {
      expect(frame.messageIds).toEqual(["msg-r"]);
    }

    ws.close(1000);
  });

  it("carries the ids onto a turn recovered before its stream started", async () => {
    const room = crypto.randomUUID();
    const agent = (await getAgentByName(
      env.ChatRecoveryTestAgent,
      room
    )) as unknown as {
      persistMessages(messages: unknown[]): Promise<void>;
      insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
      triggerFiberRecovery(): Promise<void>;
      runScheduledRecoveryRetryForTest(): Promise<void>;
    };
    await agent.persistMessages([user("msg-p")]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-pre", {
      __cfAIChatFiberSnapshot: {
        kind: "ai-chat-turn",
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
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    const terminals: ResponseFrame[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(e.data as string) as ResponseFrame;
      if (frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && frame.done) {
        terminals.push(frame);
      }
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

    ws.close(1000);
  });

  it("omits messageIds when the request carries no trailing user message", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const done = waitForTerminal(ws, "req-d");
    sendChat(ws, "req-d", [
      user("msg-d"),
      {
        id: "assistant-d",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }]
      }
    ]);
    expect((await done).messageIds).toBeUndefined();

    ws.close(1000);
  });
});
