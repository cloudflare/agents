/**
 * A request queued behind a turn when the isolate resets. The queue lives
 * in memory, so before durable admission only the running turn (which has a
 * fiber) was recovered and the waiting request was lost: its user message
 * stayed with no reply and its tab got no terminal frame. These tests reset
 * the isolate for real with `ctx.abort()`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

type AdmissionStub = {
  resetIsolateForTest(): Promise<void>;
  getPersistedMessages(): Promise<ChatMessage[]>;
  getAdmissionsForTest(): Promise<
    Array<{ requestId: string; stopped: boolean }>
  >;
  seedAdmissionForTest(requestId: string, messageIds: string[]): Promise<void>;
  seedQueuedRequestForTest(requestId: string): Promise<void>;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function user(id: string, text: string): ChatMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function sendChatRequest(
  ws: WebSocket,
  id: string,
  messages: ChatMessage[],
  body: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, format: "sse", ...body })
      }
    })
  );
}

/** Every frame a socket receives, from now on. */
function record(ws: WebSocket): unknown[] {
  const frames: unknown[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    frames.push(JSON.parse(event.data as string));
  });
  return frames;
}

function doneFrame(frames: unknown[], requestId: string) {
  return frames.find(
    (frame) =>
      isUseChatResponseMessage(frame) && frame.id === requestId && frame.done
  ) as { outcome?: string } | undefined;
}

async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await delay(100);
  }
}

function textOf(message: ChatMessage): string {
  return message.parts
    .map((part) => ("text" in part ? String(part.text) : ""))
    .join("");
}

/** Reset the agent's isolate. The call itself fails: the isolate is gone. */
async function reset(binding: string, room: string): Promise<void> {
  const stub = (await getAgentByName(
    env[binding as "RecoverySlowStreamAgent"],
    room
  )) as unknown as AdmissionStub;
  await stub.resetIsolateForTest().catch(() => {});
}

async function agent(binding: string, room: string): Promise<AdmissionStub> {
  return (await getAgentByName(
    env[binding as "RecoverySlowStreamAgent"],
    room
  )) as unknown as AdmissionStub;
}

const SLOW = { chunkCount: 30, chunkDelayMs: 100 };
const QUICK = { chunkCount: 3, chunkDelayMs: 10 };
const QUICK_REPLY = "chunk-0 chunk-1 chunk-2 ";

describe("durable admission: a request queued behind a turn a reset cuts off", () => {
  it("gets its own reply after the recovered one, and its tab its terminal frame", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    sendChatRequest(ws, "r1", [user("u1", "one")], SLOW);
    await delay(300);
    sendChatRequest(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await delay(300);

    const stub = await agent(binding, room);
    // The running turn has a fiber; the one waiting behind it has a record.
    expect(await stub.getAdmissionsForTest()).toEqual([
      { requestId: "r2", stopped: false }
    ]);

    await reset(binding, room);
    const { ws: tab } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    const frames = record(tab);
    const restarted = await agent(binding, room);

    const messages = await waitFor(
      () => restarted.getPersistedMessages(),
      (m) => m.filter((x) => x.role === "assistant").length >= 2
    );
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "user",
      "assistant",
      "assistant"
    ]);
    expect(messages.map((m) => m.id).slice(0, 2)).toEqual(["u1", "u2"]);
    // The recovered turn answers first, then the queued request.
    expect(textOf(messages[2])).not.toBe(QUICK_REPLY);
    expect(textOf(messages[3])).toBe(QUICK_REPLY);

    await waitFor(
      async () => doneFrame(frames, "r2"),
      (frame) => frame !== undefined,
      5000
    );
    // The new tab got the reply's stream under the request id, and its end.
    expect(doneFrame(frames, "r2")?.outcome ?? "completed").toBe("completed");
    expect(
      frames.some(
        (frame) =>
          isUseChatResponseMessage(frame) &&
          frame.id === "r2" &&
          !frame.done &&
          typeof frame.body === "string" &&
          frame.body.includes("chunk-0")
      )
    ).toBe(true);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
    tab.close();
  }, 40_000);

  it("a stop by its request id while it is only a record ends it aborted", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    sendChatRequest(ws, "r1", [user("u1", "one")], SLOW);
    await delay(300);
    sendChatRequest(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await delay(300);

    await reset(binding, room);
    const { ws: tab } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    const frames = record(tab);
    tab.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        id: "r2"
      })
    );

    const stub = await agent(binding, room);
    await waitFor(
      async () => doneFrame(frames, "r2"),
      (frame) => frame !== undefined
    );
    expect(doneFrame(frames, "r2")?.outcome).toBe("aborted");
    const messages = await waitFor(
      () => stub.getPersistedMessages(),
      (m) => m.some((x) => x.role === "assistant")
    );
    await delay(1000);
    expect((await stub.getPersistedMessages()).map((m) => m.role)).toEqual([
      "user",
      "user",
      "assistant"
    ]);
    expect(messages.every((m) => textOf(m) !== QUICK_REPLY)).toBe(true);
    expect(await stub.getAdmissionsForTest()).toEqual([]);
    tab.close();
  }, 40_000);

  it("a clear before the replay drops it", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    sendChatRequest(ws, "r1", [user("u1", "one")], SLOW);
    await delay(300);
    sendChatRequest(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await delay(300);

    await reset(binding, room);
    const { ws: tab } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    tab.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    const stub = await agent(binding, room);
    await waitFor(
      () => stub.getAdmissionsForTest(),
      (records) => records.length === 0,
      5000
    );
    await delay(5000);
    expect(
      (await stub.getPersistedMessages()).filter(
        (m) => textOf(m) === QUICK_REPLY
      )
    ).toEqual([]);
    tab.close();
  }, 40_000);

  it("under `latest`, a request superseded before the reset stays superseded", async () => {
    const room = crypto.randomUUID();
    const binding = "LatestMessageConcurrencyAgent";
    const path = `/agents/latest-message-concurrency-agent/${room}`;
    const { ws } = await connectChatWS(path);
    sendChatRequest(ws, "r1", [user("u1", "one")], SLOW);
    await delay(300);
    sendChatRequest(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await delay(100);
    sendChatRequest(
      ws,
      "r3",
      [user("u1", "one"), user("u2", "two"), user("u3", "three")],
      QUICK
    );
    await delay(300);

    await reset(binding, room);
    const { ws: tab } = await connectChatWS(path);
    const frames = record(tab);
    const stub = await agent(binding, room);
    const messages = await waitFor(
      () => stub.getPersistedMessages(),
      (m) => m.filter((x) => x.role === "assistant").length >= 2
    );
    await delay(500);
    expect((await stub.getPersistedMessages()).map((m) => m.role)).toEqual([
      "user",
      "user",
      "user",
      "assistant",
      "assistant"
    ]);
    expect(textOf(messages[4])).toBe(QUICK_REPLY);
    expect(doneFrame(frames, "r2")?.outcome).toBe("skipped");
    tab.close();
  }, 40_000);

  it("a record left between the turn's fiber and the record's delete is recovery's", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    sendChatRequest(ws, "r1", [user("u1", "one")], SLOW);
    await delay(300);
    const stub = await agent(binding, room);
    // The fiber is there and the record is still there, as a reset in
    // between leaves them.
    await stub.seedAdmissionForTest("r1", ["u1"]);

    await reset(binding, room);
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getPersistedMessages(),
      (m) => m.some((x) => x.role === "assistant")
    );
    await delay(4000);
    const messages = await restarted.getPersistedMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
  }, 40_000);

  it("a request replayed after a reset runs once the app's onStart is done", async () => {
    const room = crypto.randomUUID();
    const binding = "AsyncStartAdmissionAgent";
    const stub = await agent(binding, room);
    await stub.seedQueuedRequestForTest("r9");
    await reset(binding, room);
    const restarted = await agent(binding, room);
    const messages = await waitFor(
      () => restarted.getPersistedMessages(),
      (m) => m.some((x) => x.role === "assistant")
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(messages[1])).toBe(QUICK_REPLY);
  }, 40_000);
});
