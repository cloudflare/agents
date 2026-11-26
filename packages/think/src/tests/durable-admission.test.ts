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
  getIncidentsForTest(): Promise<string[]>;
  getAdmissionsForTest(): Promise<
    Array<{ requestId: string; stopped: boolean }>
  >;
  seedAdmissionForTest(requestId: string, messageIds: string[]): Promise<void>;
  ageAdmissionsForTest(ms: number): Promise<void>;
  isIdleForTest(): Promise<boolean>;
  getModelRequestsForTest(): Promise<
    Array<Array<{ role: string; text: string }>>
  >;
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
      const frame = JSON.parse(event.data as string);
      frames.push(frame);
      // A tab acks a resumed stream, as a client does.
      if (frame.type === "cf_agent_stream_resuming") {
        ws.send(
          JSON.stringify({ type: "cf_agent_stream_resume_ack", id: frame.id })
        );
      }
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

/** Wait until request `id` has streamed a chunk to this socket. */
async function streaming(frames: Array<Record<string, unknown>>, id: string) {
  const started = await waitFor(
    async () =>
      frames.some(
        (f) => f.type === MSG_CHAT_RESPONSE && f.id === id && f.done !== true
      ),
    (yes) => yes,
    5000
  );
  if (!started) throw new Error(`${id} never streamed`);
}

/** Wait until request `id` has its admission record. */
async function admitted(binding: Binding, room: string, id: string) {
  const records = await waitFor(
    async () => (await agent(binding, room)).getAdmissionsForTest(),
    (list) => list.some((r) => r.requestId === id),
    5000
  );
  if (!records.some((r) => r.requestId === id)) {
    throw new Error(`${id} was never admitted`);
  }
}

async function queueBehindSlowTurn(binding: Binding, room: string) {
  const ws = await connect(binding, room);
  const frames = record(ws);
  send(ws, "r1", [user("u1", "one")], SLOW);
  await streaming(frames, "r1");
  send(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
  await admitted(binding, room, "r2");
  return ws;
}

/**
 * Wait until the agent has nothing left to run, so a check that nothing
 * more happens reads the final state.
 */
async function idle(stub: AdmissionStub) {
  const done = await waitFor(
    () => stub.isIdleForTest(),
    (yes) => yes,
    20_000
  );
  if (!done) throw new Error("the agent never went idle");
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
    await idle(restarted);
    const final = await restarted.getMessagesForTest();
    const assistants = final.filter((m) => m.role === "assistant");
    expect(
      assistants.map(textOf).filter((t) => t === QUICK_REPLY)
    ).toHaveLength(1);
    // The recovered turn answered first, then the queued request.
    expect(assistants).toHaveLength(2);
    expect(textOf(assistants[0])).toContain("s");
    expect(textOf(assistants[1])).toBe(QUICK_REPLY);
    // Each reply follows the question it answers.
    expect(final.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(final[0].id).toBe("u1");
    expect(final[2].id).toBe("u2");
    expect(messages.filter((m) => m.role === "user").map((m) => m.id)).toEqual([
      "u1",
      "u2"
    ]);
    // The recovered turn never saw the queued question, and the queued
    // turn's request ends in it.
    const requests = await restarted.getModelRequestsForTest();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      if (request.some((m) => m.text.includes("two"))) {
        expect(request.at(-1)?.role).toBe("user");
        expect(request.at(-1)?.text).toContain("two");
      }
    }
    expect(
      requests.filter((r) => r.some((m) => m.text.includes("two")))
    ).toHaveLength(1);
    await waitFor(
      async () => doneFrame(frames, "r2"),
      (f) => f !== undefined,
      5000
    );
    expect(frames.some((f) => f.id === "r2" && f.done !== true)).toBe(true);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
    tab.close();
  }, 40_000);

  it("runs however long it waited: its question is never dropped", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    await queueBehindSlowTurn(binding, room);
    // The turn ahead of it ran for two hours (a long agent-tool run).
    await (await agent(binding, room)).ageAdmissionsForTest(2 * 60 * 60 * 1000);
    await reset(binding, room);
    const restarted = await agent(binding, room);
    const messages = await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => textOf(x) === QUICK_REPLY)
    );
    expect(messages.map((m) => m.id)).toContain("u2");
    expect(textOf(messages.at(-1)!)).toBe(QUICK_REPLY);
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
    await idle(restarted);
    const messages = await restarted.getMessagesForTest();
    expect(messages.some((m) => textOf(m) === QUICK_REPLY)).toBe(false);
    // The stopped request's question is kept, after the reply before it,
    // with no reply of its own.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2].id).toBe("u2");
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
    await idle(restarted);
    const messages = await restarted.getMessagesForTest();
    expect(messages.some((m) => textOf(m) === QUICK_REPLY)).toBe(false);
    tab.close();
  }, 40_000);

  it("under `latest`, a request superseded before the reset stays superseded", async () => {
    const binding = "ThinkLatestAdmissionTestAgent";
    const room = crypto.randomUUID();
    const ws = await connect(binding, room);
    const sent = record(ws);
    send(ws, "r1", [user("u1", "one")], SLOW);
    await streaming(sent, "r1");
    send(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await admitted(binding, room, "r2");
    send(
      ws,
      "r3",
      [user("u1", "one"), user("u2", "two"), user("u3", "three")],
      { ...QUICK, tag: "t" }
    );
    await admitted(binding, room, "r3");

    await reset(binding, room);
    const tab = await connect(binding, room);
    const frames = record(tab);
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => textOf(x) === "t0 t1 t2 ")
    );
    await idle(restarted);
    const messages = await restarted.getMessagesForTest();
    expect(messages.some((m) => textOf(m) === QUICK_REPLY)).toBe(false);
    // Skipped on the lane when r3 arrived, before the reset: it does not
    // come back.
    expect(doneFrame(sent, "r2")?.outcome).toBe("skipped");
    expect(doneFrame(frames, "r2")).toBeUndefined();
    // The superseded question is kept, and answered with the latest.
    expect(messages.filter((m) => m.role === "user").map((m) => m.id)).toEqual([
      "u1",
      "u2",
      "u3"
    ]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
      "assistant"
    ]);
    tab.close();
  }, 40_000);

  it("a record left between the turn's fiber and the record's delete is recovery's", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    const ws = await connect(binding, room);
    const sent = record(ws);
    send(ws, "r1", [user("u1", "one")], SLOW);
    await streaming(sent, "r1");
    await (await agent(binding, room)).seedAdmissionForTest("r1", ["u1"]);

    await reset(binding, room);
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => m.some((x) => x.role === "assistant")
    );
    await idle(restarted);
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

describe("a client tool call a reset cut off", () => {
  it("an answer then a reset: the restored continuation's tab gets its done frame", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const once = async (gap: number) => {
      const room = crypto.randomUUID();
      const ws = await connect(binding, room);
      const sent = record(ws);
      send(ws, "r1", [user("u1", "one")], {
        clientToolThenEnd: true,
        clientTools: [{ name: "client_action", description: "A client tool" }]
      });
      await waitFor(
        async () => sent,
        (frames) => doneFrame(frames, "r1") !== undefined
      );
      ws.send(
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "tc-client-1",
          toolName: "client_action",
          output: "done",
          autoContinue: true
        })
      );
      // Around the coalesce window: fired or not when the reset lands.
      await delay(gap);
      await reset(binding, room);

      const tab = await connect(binding, room);
      const frames = record(tab);
      tab.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
      const restarted = await agent(binding, room);
      const stored = JSON.stringify(
        await waitFor(
          () => restarted.getMessagesForTest(),
          (m) => JSON.stringify(m).includes("Continuation after tool")
        )
      ).includes("Continuation after tool");
      const done = (list: Array<Record<string, unknown>>) =>
        list.some(
          (frame) =>
            frame.type === MSG_CHAT_RESPONSE &&
            frame.done === true &&
            frame.id !== "r1"
        );
      const streamed = (list: Array<Record<string, unknown>>) =>
        list.some(
          (frame) =>
            frame.type === MSG_CHAT_RESPONSE &&
            frame.id !== "r1" &&
            frame.done !== true
        );
      // A replay can arrive after the transcript read: give it time, then
      // judge what the tab got.
      const seen = await waitFor(async () => frames, done, 5_000);
      return {
        stored,
        streamed: streamed(seen),
        // A tab that got the stream gets its end.
        ended: !streamed(seen) || done(seen)
      };
    };
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => once(i * 6))
    );
    // Some tabs reconnect while the continuation streams.
    expect(results.some((r) => r.streamed)).toBe(true);
    // The reset never loses the answer's continuation.
    expect(results.filter((r) => !r.stored)).toEqual([]);
    expect(results.filter((r) => !r.ended)).toEqual([]);
  }, 120_000);

  it("continues with the client's answer, without waiting out recovery", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    const ws = await connect(binding, room);
    const sent = record(ws);
    send(ws, "r1", [user("u1", "one")], {
      clientToolThenHang: true,
      clientTools: [{ name: "client_action", description: "A client tool" }]
    });
    // The call reached the tab before the reset cut the reply.
    await waitFor(
      async () => sent,
      (frames) => JSON.stringify(frames).includes("tc-client-1")
    );
    await reset(binding, room);

    const tab = await connect(binding, room);
    const frames = record(tab);
    const restarted = await agent(binding, room);
    // Recovery stores the cut-off reply, its call waiting on the client.
    await waitFor(
      () => restarted.getMessagesForTest(),
      (messages) => JSON.stringify(messages).includes("tc-client-1")
    );
    const answeredAt = Date.now();
    tab.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tc-client-1",
        toolName: "client_action",
        output: "done",
        autoContinue: true
      })
    );
    const messages = await waitFor(
      () => restarted.getMessagesForTest(),
      (m) => JSON.stringify(m).includes("Continuation after tool")
    );
    expect(JSON.stringify(messages)).toContain("Continuation after tool");
    expect(Date.now() - answeredAt).toBeLessThan(15_000);
    // The answer's continuation took the reply; recovery stepped aside.
    expect(await restarted.getIncidentsForTest()).toEqual([
      "skipped:continued_by_interaction"
    ]);
    // Its done frame is sent after the reply is stored.
    const completed = (list: Array<Record<string, unknown>>) =>
      list.some(
        (frame) =>
          frame.type === MSG_CHAT_RESPONSE &&
          frame.done === true &&
          frame.id !== "r1" &&
          frame.error !== true &&
          (frame.outcome ?? "completed") === "completed"
      );
    expect(completed(await waitFor(async () => frames, completed))).toBe(true);
    // The cut-off request is not reported as failed.
    expect(JSON.stringify(doneFrame(frames, "r1") ?? {})).not.toContain(
      "interrupted"
    );
    tab.close();
  }, 40_000);
});
