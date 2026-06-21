import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_TOOL_APPROVAL = "cf_agent_tool_approval";

async function freshAttachAgent(name: string) {
  return getAgentByName(env.ThinkToolsTestAgent, name);
}

async function connectWS(agentClass: string, room: string) {
  const slug = agentClass
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  const res = await exports.default.fetch(
    `http://example.com/agents/${slug}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function waitForDone(
  ws: WebSocket,
  timeout = 10000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

function sendChatRequest(ws: WebSocket, text: string) {
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id: crypto.randomUUID(),
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage] })
      }
    })
  );
}

function parseAttachments(json: string): Array<Record<string, unknown>> {
  return JSON.parse(json) as Array<Record<string, unknown>>;
}

describe("action reply attachments", () => {
  it("records attachments on ChatResponseResult without changing tool output", async () => {
    const agent = await freshAttachAgent(`ar-basic-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("two");

    const result = await agent.testChat("call attachAction");
    expect(result.done).toBe(true);

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual([
      { type: "voice_note" },
      { type: "card", payload: { id: 1 } }
    ]);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const part = messages
      .flatMap((message) => message.parts)
      .find((candidate) => "toolCallId" in candidate) as
      | Record<string, unknown>
      | undefined;
    expect(part).toMatchObject({
      toolCallId: "ar1",
      state: "output-available",
      output: "attached"
    });
  });

  it("ignores invalid attachments", async () => {
    const agent = await freshAttachAgent(`ar-invalid-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("invalid");

    await agent.testChat("call attachAction");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
  });

  it("normalizes non-json-safe attachment payloads", async () => {
    const agent = await freshAttachAgent(`ar-non-json-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("non-json");

    await agent.testChat("call attachAction");

    const attachments = parseAttachments(
      await agent.getResponseAttachmentsJson()
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: "card",
      payload: {
        big: "1n",
        self: "[Circular]"
      }
    });
  });

  it("caps attachments per turn", async () => {
    const agent = await freshAttachAgent(`ar-overcap-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("overcap");

    await agent.testChat("call attachAction");

    const attachments = parseAttachments(
      await agent.getResponseAttachmentsJson()
    );
    expect(attachments).toHaveLength(32);
    expect(attachments[0]).toMatchObject({ type: "x", i: 0 });
    expect(attachments[31]).toMatchObject({ type: "x", i: 31 });
  });

  it("resets across turns and keeps post-turn getter scoped by request id", async () => {
    const agent = await freshAttachAgent(`ar-reset-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("two");
    await agent.testChat("call attachAction");

    const requestId = await agent.getLastResponseRequestIdForTest();
    expect(requestId).toEqual(expect.any(String));
    expect(
      parseAttachments(await agent.replyAttachmentsJsonForTest(requestId ?? ""))
    ).toHaveLength(2);
    expect(
      parseAttachments(await agent.replyAttachmentsJsonForTest("bogus"))
    ).toEqual([]);

    await agent.mutateLastResponseAttachmentForTest();
    expect(
      parseAttachments(await agent.replyAttachmentsJsonForTest(requestId ?? ""))
    ).toEqual([{ type: "voice_note" }, { type: "card", payload: { id: 1 } }]);

    await agent.clearResponseLogForTest();
    await agent.useAttachReplyActionForTest("none");
    await agent.testChat("call attachAction again");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
  });

  it("does not re-fire attachments on action ledger replay", async () => {
    const agent = await freshAttachAgent(`ar-ledger-${crypto.randomUUID()}`);
    await agent.useEchoActionForTest("attach-ledger");
    await agent.setActionIdempotencyKey("attach-ledger-key");

    await agent.testChat("call echo action");
    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual([
      { type: "voice_note" }
    ]);
    expect((await agent.getActionProbe()).count).toBe(1);

    await agent.clearResponseLogForTest();
    await agent.testChat("call echo action again");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
    expect((await agent.getActionProbe()).count).toBe(1);
  });

  it("does not record attachments from function-valued idempotency keys", async () => {
    const agent = await freshAttachAgent(
      `ar-idempotency-policy-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("attach-idempotency-key");
    await agent.setActionIdempotencyKey("attach-idempotency-key");

    await agent.testChat("call echo action");
    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual([
      { type: "voice_note" }
    ]);
    expect((await agent.getActionProbe()).count).toBe(1);

    await agent.clearResponseLogForTest();
    await agent.testChat("call echo action again");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
    expect((await agent.getActionProbe()).count).toBe(1);
  });

  it("treats attachReply in approval predicates as a no-op", async () => {
    const agent = await freshAttachAgent(`ar-predicate-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("predicate-noop");

    await agent.testChat("call attachAction");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
  });

  it("treats attachReply in permission policies as a no-op", async () => {
    const agent = await freshAttachAgent(
      `ar-permission-${crypto.randomUUID()}`
    );
    await agent.useAttachReplyActionForTest("permission-noop");

    await agent.testChat("call attachAction");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
  });

  it("discards attachments from failed actions", async () => {
    const agent = await freshAttachAgent(`ar-failed-${crypto.randomUUID()}`);
    await agent.useAttachReplyActionForTest("attach-then-throw");

    await agent.testChat("call attachAction");

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual(
      []
    );
  });

  it("supports attachReply after an approval-gated action is approved", async () => {
    const room = `ar-approval-${crypto.randomUUID()}`;
    const agent = await freshAttachAgent(room);
    await agent.useAttachReplyActionForTest("approval-gated");
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call attachAction");
    await initialDone;

    await agent.clearResponseLogForTest();
    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "ar1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect(parseAttachments(await agent.getResponseAttachmentsJson())).toEqual([
      { type: "voice_note" }
    ]);
    await closeWS(ws);
  });

  it("treats attachReply from durable-pause approved actions as a no-op", async () => {
    const agent = await freshAttachAgent(`ar-durable-${crypto.randomUUID()}`);
    await agent.useDurablePauseActionForTest({ attachReply: true });
    const parked = (await agent.parkDurablePauseForTest("hello")) as {
      executionId?: string;
    };

    await agent.approveExecutionForTest(parked.executionId ?? "");

    expect(parseAttachments(await agent.replyAttachmentsJsonForTest())).toEqual(
      []
    );
  });
});
