/**
 * A request queued behind a turn when the isolate resets. The queue lives
 * in memory, so before durable admission only the running turn (which has a
 * fiber) was recovered and the waiting request was lost: its user message
 * stayed with no reply and its tab got no terminal frame. These tests reset
 * the isolate for real with `ctx.abort()`.
 */
import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_CANCEL = "cf_agent_chat_request_cancel";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";

type AdmissionStub = {
  resetIsolateForTest(): Promise<void>;
  submitMessages(
    messages: UIMessage[],
    options: { submissionId: string }
  ): Promise<{ status: string }>;
  listSubmissions(): Promise<Array<{ submissionId: string; status: string }>>;
  getMessagesForTest(): Promise<UIMessage[]>;
  getAdmissionsForTest(): Promise<
    Array<{ requestId: string; stopped: boolean }>
  >;
  seedAdmissionForTest(requestId: string, messageIds: string[]): Promise<void>;
};

type Binding = "ThinkAdmissionTestAgent" | "ThinkLatestAdmissionTestAgent";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function agent(binding: Binding, room: string): Promise<AdmissionStub> {
  return (await getAgentByName(env[binding], room)) as unknown as AdmissionStub;
}

async function connect(binding: Binding, room: string): Promise<WebSocket> {
  const slug = binding
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  const res = await exports.default.fetch(
    `http://example.com/agents/${slug}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function send(
  ws: WebSocket,
  id: string,
  messages: UIMessage[],
  body: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: { method: "POST", body: JSON.stringify({ messages, ...body }) }
    })
  );
}

function record(ws: WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      frames.push(JSON.parse(event.data as string));
    } catch {
      // not JSON
    }
  });
  return frames;
}

function doneFrame(frames: Array<Record<string, unknown>>, id: string) {
  return frames.find(
    (f) => f.type === MSG_CHAT_RESPONSE && f.id === id && f.done === true
  );
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

function textOf(message: UIMessage): string {
  return message.parts
    .map((part) => ("text" in part ? String(part.text) : ""))
    .join("");
}

const SLOW = { tag: "s", chunks: 30, delayMs: 100 };
const QUICK = { tag: "q", chunks: 3, delayMs: 10 };
const QUICK_REPLY = "q0 q1 q2 ";

async function queueBehindSlowTurn(binding: Binding, room: string) {
  const ws = await connect(binding, room);
  send(ws, "r1", [user("u1", "one")], SLOW);
  await delay(400);
  send(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
  await delay(300);
  return ws;
}

async function reset(binding: Binding, room: string) {
  await (await agent(binding, room)).resetIsolateForTest().catch(() => {});
}

describe("durable admission: a request queued behind a turn a reset cuts off", () => {
  it("gets its own reply after the recovered one, and its tab its stream", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    await queueBehindSlowTurn(binding, room);
    expect(await (await agent(binding, room)).getAdmissionsForTest()).toEqual([
      { requestId: "r2", stopped: false }
    ]);

    await reset(binding, room);
    const tab = await connect(binding, room);
    const frames = record(tab);
    const restarted = await agent(binding, room);
    const messages = await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => x.role === "assistant" && textOf(x) === QUICK_REPLY)
    );
    await delay(500);
    const final = await restarted.getMessagesForTest();
    const assistants = final.filter((m) => m.role === "assistant");
    expect(
      assistants.map(textOf).filter((t) => t === QUICK_REPLY)
    ).toHaveLength(1);
    // The recovered turn answered first, then the queued request.
    expect(assistants).toHaveLength(2);
    expect(textOf(assistants[0])).toContain("s");
    expect(textOf(assistants[1])).toBe(QUICK_REPLY);
    expect(messages.filter((m) => m.role === "user").map((m) => m.id)).toEqual([
      "u1",
      "u2"
    ]);
    await waitFor(
      async () => doneFrame(frames, "r2"),
      (f) => f !== undefined,
      5000
    );
    expect(frames.some((f) => f.id === "r2" && f.done !== true)).toBe(true);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
    tab.close();
  }, 40_000);

  it("a stop by its request id while it is only a record ends it aborted", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    await queueBehindSlowTurn(binding, room);
    await reset(binding, room);
    const tab = await connect(binding, room);
    const frames = record(tab);
    tab.send(JSON.stringify({ type: MSG_CHAT_CANCEL, id: "r2" }));
    const restarted = await agent(binding, room);
    await waitFor(
      async () => doneFrame(frames, "r2"),
      (f) => f !== undefined
    );
    expect(doneFrame(frames, "r2")?.outcome).toBe("aborted");
    await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => x.role === "assistant")
    );
    await delay(1000);
    const messages = await restarted.getMessagesForTest();
    expect(messages.some((m) => textOf(m) === QUICK_REPLY)).toBe(false);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
    tab.close();
  }, 40_000);

  it("a clear before the replay drops it", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    await queueBehindSlowTurn(binding, room);
    await reset(binding, room);
    const tab = await connect(binding, room);
    tab.send(JSON.stringify({ type: MSG_CHAT_CLEAR }));
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getAdmissionsForTest(),
      (r) => r.length === 0,
      5000
    );
    await delay(5000);
    const messages = await restarted.getMessagesForTest();
    expect(messages.some((m) => textOf(m) === QUICK_REPLY)).toBe(false);
    tab.close();
  }, 40_000);

  it("under `latest`, a request superseded before the reset stays superseded", async () => {
    const binding = "ThinkLatestAdmissionTestAgent";
    const room = crypto.randomUUID();
    const ws = await connect(binding, room);
    send(ws, "r1", [user("u1", "one")], SLOW);
    await delay(400);
    send(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await delay(100);
    send(
      ws,
      "r3",
      [user("u1", "one"), user("u2", "two"), user("u3", "three")],
      { ...QUICK, tag: "t" }
    );
    await delay(300);

    await reset(binding, room);
    const tab = await connect(binding, room);
    const frames = record(tab);
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => textOf(x) === "t0 t1 t2 ")
    );
    await delay(500);
    const messages = await restarted.getMessagesForTest();
    expect(messages.some((m) => textOf(m) === QUICK_REPLY)).toBe(false);
    expect(doneFrame(frames, "r2")?.outcome).toBe("skipped");
    tab.close();
  }, 40_000);

  it("a record left between the turn's fiber and the record's delete is recovery's", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    const ws = await connect(binding, room);
    send(ws, "r1", [user("u1", "one")], SLOW);
    await delay(400);
    await (await agent(binding, room)).seedAdmissionForTest("r1", ["u1"]);

    await reset(binding, room);
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => x.role === "assistant")
    );
    await delay(4000);
    const messages = await restarted.getMessagesForTest();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
  }, 40_000);

  it("submissions: one running and one pending at the reset each get their own reply, in order", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    const stub = await agent(binding, room);
    await stub.submitMessages([user("u1", "slow one")], { submissionId: "s1" });
    await stub.submitMessages([user("u2", "quick two")], {
      submissionId: "s2"
    });
    await waitFor(
      () => stub.listSubmissions(),
      (subs) =>
        subs.some((x) => x.submissionId === "s1" && x.status === "running"),
      5000
    );
    await delay(800);

    await reset(binding, room);
    const restarted = await agent(binding, room);
    const subs = await waitFor(
      () => restarted.listSubmissions(),
      (list) =>
        list.length === 2 &&
        list.every((x) => x.status !== "running" && x.status !== "pending")
    );
    expect(
      Object.fromEntries(subs.map((x) => [x.submissionId, x.status]))
    ).toEqual({ s1: "completed", s2: "completed" });
    const messages = await restarted.getMessagesForTest();
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(messages[0].id).toBe("u1");
    expect(textOf(messages[1]).startsWith("s0 ")).toBe(true);
    expect(messages[2].id).toBe("u2");
    expect(textOf(messages[3])).toBe(QUICK_REPLY);
  }, 60_000);
});
