/**
 * A request queued behind a turn when the isolate resets. The queue lives
 * in memory, so before durable admission only the running turn (which has a
 * fiber) was recovered and the waiting request was lost: its user message
 * stayed with no reply and its tab got no terminal frame. These tests reset
 * the isolate for real with `ctx.abort()`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished } from "vitest";
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
  turnInNextOnStartForTest(): Promise<void>;
  getTranscriptsSeenForTest(): Promise<string[][]>;
  getIncidentsForTest(): Promise<string[]>;
  ageAdmissionsForTest(ms: number): Promise<void>;
  waitUntilStableForTest(): Promise<boolean>;
  waitForIdleForTest(): Promise<unknown>;
  holdStreamForTest(requestId: string): Promise<void>;
  isStreamHeldForTest(requestId: string): Promise<boolean>;
  releaseStreamForTest(requestId: string): Promise<void>;
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
/** Record what a tab is sent; it acks a resumed stream, as a client does. */
function record(ws: WebSocket): unknown[] {
  const frames: unknown[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    const frame = JSON.parse(event.data as string) as {
      type?: unknown;
      id?: unknown;
    };
    frames.push(frame);
    if (frame.type === MessageType.CF_AGENT_STREAM_RESUMING) {
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: frame.id
        })
      );
    }
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
    if (ok(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out; last value: ${JSON.stringify(value)}`
      );
    }
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

/**
 * Send r1 and hold its stream after its first chunk, so it is still running
 * whenever the test resets the isolate (the reset drops the hold).
 */
async function holdRunning(ws: WebSocket, stub: AdmissionStub): Promise<void> {
  await stub.holdStreamForTest("r1");
  onTestFinished(() => stub.releaseStreamForTest("r1").catch(() => {}));
  sendChatRequest(ws, "r1", [user("u1", "one")], SLOW);
  await waitFor(
    () => stub.isStreamHeldForTest("r1"),
    (held) => held
  );
}

/**
 * Start r1 (slow) and queue r2 behind it, then wait until r2 is a durable
 * record waiting on r1: the state a reset is meant to find.
 */
async function queueBehindRunningTurn(
  ws: WebSocket,
  stub: AdmissionStub
): Promise<void> {
  await holdRunning(ws, stub);
  sendChatRequest(ws, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
  await waitFor(
    () => stub.getAdmissionsForTest(),
    (records) => records.some((record) => record.requestId === "r2")
  );
}

/**
 * Wait until nothing is left to run: no record, no turn (a restored request
 * that is streaming has no record any more), and a stable chat.
 */
async function settled(stub: AdmissionStub): Promise<void> {
  await waitFor(
    () => stub.getAdmissionsForTest(),
    (records) => records.length === 0
  );
  await stub.waitForIdleForTest();
  await stub.waitUntilStableForTest();
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
    await queueBehindRunningTurn(ws, await agent(binding, room));

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
    // Each reply follows the question it answers.
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(messages[0].id).toBe("u1");
    expect(messages[2].id).toBe("u2");
    // The recovered turn answers first, then the queued request.
    expect(textOf(messages[1])).not.toBe(QUICK_REPLY);
    expect(textOf(messages[3])).toBe(QUICK_REPLY);
    // The recovered turn never saw the queued question. The queued turn's
    // transcript ends in its own question.
    const seen = await restarted.getTranscriptsSeenForTest();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const transcript of seen) {
      if (transcript.includes("u2")) expect(transcript.at(-1)).toBe("u2");
    }
    expect(seen.at(-1)).toEqual(["u1", messages[1].id, "u2"]);

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

  it("runs however long it waited: its question is never dropped", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    await queueBehindRunningTurn(ws, await agent(binding, room));
    // The turn ahead of it ran for two hours (a long agent-tool run).
    await (await agent(binding, room)).ageAdmissionsForTest(2 * 60 * 60 * 1000);
    await reset(binding, room);
    const restarted = await agent(binding, room);
    const messages = await waitFor(
      () => restarted.getPersistedMessages(),
      (m) => m.some((x) => textOf(x) === QUICK_REPLY)
    );
    expect(messages.map((m) => m.id)).toContain("u2");
    expect(textOf(messages.at(-1)!)).toBe(QUICK_REPLY);
  }, 40_000);

  it("a stop by its request id while it is only a record ends it aborted", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    await queueBehindRunningTurn(ws, await agent(binding, room));

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
    await settled(stub);
    // The stopped request's question is kept, after the reply before it,
    // with no reply of its own.
    expect((await stub.getPersistedMessages()).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user"
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
    await queueBehindRunningTurn(ws, await agent(binding, room));

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
    await settled(stub);
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
    const sent = record(ws);
    const first = await agent(binding, room);
    await queueBehindRunningTurn(ws, first);
    sendChatRequest(
      ws,
      "r3",
      [user("u1", "one"), user("u2", "two"), user("u3", "three")],
      QUICK
    );
    // r3 superseded r2 before the reset: r2 was told, r3 is the record.
    await waitFor(
      async () => doneFrame(sent, "r2"),
      (frame) => frame !== undefined
    );
    await waitFor(
      () => first.getAdmissionsForTest(),
      (records) => records.some((record) => record.requestId === "r3")
    );

    await reset(binding, room);
    const { ws: tab } = await connectChatWS(path);
    const frames = record(tab);
    const stub = await agent(binding, room);
    const messages = await waitFor(
      () => stub.getPersistedMessages(),
      (m) => m.filter((x) => x.role === "assistant").length >= 2
    );
    await settled(stub);
    // The superseded question is kept, and answered with the latest.
    expect((await stub.getPersistedMessages()).map((m) => m.id)).toEqual([
      "u1",
      messages[1].id,
      "u2",
      "u3",
      messages[4].id
    ]);
    expect(textOf(messages[4])).toBe(QUICK_REPLY);
    // Skipped on the lane when r3 arrived, before the reset: it does not
    // come back.
    expect(doneFrame(sent, "r2")?.outcome).toBe("skipped");
    expect(doneFrame(frames, "r2")).toBeUndefined();
    tab.close();
  }, 40_000);

  it("a record left between the turn's fiber and the record's delete is recovery's", async () => {
    const room = crypto.randomUUID();
    const binding = "RecoverySlowStreamAgent";
    const { ws } = await connectChatWS(
      `/agents/recovery-slow-stream-agent/${room}`
    );
    const stub = await agent(binding, room);
    await holdRunning(ws, stub);
    // The fiber is there and the record is still there, as a reset in
    // between leaves them.
    await stub.seedAdmissionForTest("r1", ["u1"]);

    await reset(binding, room);
    const restarted = await agent(binding, room);
    await waitFor(
      () => restarted.getPersistedMessages(),
      (m) => m.some((x) => x.role === "assistant")
    );
    await settled(restarted);
    const messages = await restarted.getPersistedMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await restarted.getAdmissionsForTest()).toEqual([]);
  }, 40_000);

  it("an onStart that waits for its own turn is not held behind a replay", async () => {
    const room = crypto.randomUUID();
    const binding = "AsyncStartAdmissionAgent";
    const stub = await agent(binding, room);
    await stub.seedQueuedRequestForTest("r9");
    await stub.turnInNextOnStartForTest();
    await reset(binding, room);
    const restarted = await agent(binding, room);
    // The onStart turn runs first; the replay runs once onStart is done.
    const messages = await waitFor(
      () => restarted.getPersistedMessages(),
      (m) => m.filter((x) => x.role === "assistant").length === 2,
      15_000
    );
    // onStart's turn answers first, then the replay.
    expect(
      messages.map((m) => [m.role, m.role === "user" ? m.id : ""])
    ).toEqual([
      ["user", "on-start"],
      ["assistant", ""],
      ["user", "u-r9"],
      ["assistant", ""]
    ]);
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

describe("a tool call a reset cut off", () => {
  it.each([
    {
      hangOn: "call",
      answer: {
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolName: "chooseOption",
        output: { choice: "a" }
      }
    },
    {
      hangOn: "approval",
      answer: { type: MessageType.CF_AGENT_TOOL_APPROVAL, approved: true }
    }
  ])(
    "continues with the client's answer ($hangOn), without waiting out recovery",
    async ({ hangOn, answer }) => {
      const room = crypto.randomUUID();
      const binding = "RecoverySlowStreamAgent";
      const path = `/agents/recovery-slow-stream-agent/${room}`;
      const { ws } = await connectChatWS(path);
      sendChatRequest(ws, "r1", [user("u1", "one")], {
        toolThenHang: hangOn,
        ...(hangOn === "call" && { clientTools: [{ name: "chooseOption" }] })
      });
      // The call reached the tab before the reset cut the reply.
      const sent = record(ws);
      await waitFor(
        async () => sent,
        (frames) => JSON.stringify(frames).includes("call-hang")
      );
      await reset(binding, room);

      const { ws: tab } = await connectChatWS(path);
      const frames = record(tab);
      const stub = await agent(binding, room);
      // Recovery stores the cut-off reply, its call waiting on the client.
      await waitFor(
        () => stub.getPersistedMessages(),
        (messages) => JSON.stringify(messages).includes("call-hang")
      );
      const answeredAt = Date.now();
      tab.send(
        JSON.stringify({
          ...answer,
          toolCallId: "call-hang",
          autoContinue: true
        })
      );
      const messages = await waitFor(
        () => stub.getPersistedMessages(),
        (m) => m.some((x) => x.role === "assistant" && textOf(x).length > 0)
      );
      expect(
        messages.some((x) => x.role === "assistant" && textOf(x).length > 0)
      ).toBe(true);
      expect(Date.now() - answeredAt).toBeLessThan(15_000);
      // The answer's continuation took the reply; recovery stepped aside.
      expect(await stub.getIncidentsForTest()).toEqual([
        "skipped:continued_by_interaction"
      ]);
      // Its done frame is sent after the reply is stored.
      const completed = (list: unknown[]) =>
        list.some(
          (frame) =>
            isUseChatResponseMessage(frame) &&
            frame.done &&
            frame.id !== "r1" &&
            !(frame as { error?: boolean }).error &&
            (frame as { outcome?: string }).outcome === "completed"
        );
      expect(completed(await waitFor(async () => frames, completed))).toBe(
        true
      );
      // The cut-off request is not reported as failed.
      expect(JSON.stringify(doneFrame(frames, "r1") ?? {})).not.toContain(
        "interrupted"
      );
      tab.close();
    },
    40_000
  );
});

describe("two resets a few seconds apart", () => {
  it.each([
    { name: "", sendAfter: false },
    { name: ", and a new request sent after the second", sendAfter: true }
  ])(
    "the request cut at the first reset is answered before the one queued behind it$name",
    async ({ sendAfter }) => {
      const room = crypto.randomUUID();
      const binding = "RecoverySlowStreamAgent";
      const path = `/agents/recovery-slow-stream-agent/${room}`;
      const { ws } = await connectChatWS(path);
      await queueBehindRunningTurn(ws, await agent(binding, room));

      await reset(binding, room);
      // The recovered turn starts streaming the cut reply's continuation.
      const { ws: tab } = await connectChatWS(path);
      const recovered = record(tab);
      const second = await agent(binding, room);
      await waitFor(
        () => second.getTranscriptsSeenForTest(),
        (seen) => seen.length >= 1
      );
      // Cut it mid-stream: once its first chunk reached the tab.
      await waitFor(
        async () => recovered,
        (frames) =>
          frames.some(
            (frame) =>
              isUseChatResponseMessage(frame) &&
              !frame.done &&
              typeof frame.body === "string" &&
              frame.body.includes("chunk-")
          )
      );
      // The second reset cuts the recovered reply.
      await reset(binding, room);
      tab.close();

      const { ws: tab2 } = await connectChatWS(path);
      record(tab2);
      const third = await agent(binding, room);
      // A request the tab sends now waits behind the cut reply's recovery.
      if (sendAfter) {
        sendChatRequest(
          tab2,
          "r3",
          [user("u1", "one"), user("u2", "two"), user("u3", "three")],
          QUICK
        );
      }
      const messages = await waitFor(
        () => third.getPersistedMessages(),
        (m) =>
          m.filter((x) => x.role === "assistant").length >= (sendAfter ? 3 : 2),
        30_000
      );
      // u1 is answered, then each later question in turn.
      const asked = sendAfter ? ["u1", "u2", "u3"] : ["u1", "u2"];
      expect(messages.map((m) => m.role)).toEqual(
        asked.flatMap(() => ["user", "assistant"])
      );
      expect(
        messages.filter((m) => m.role === "user").map((m) => m.id)
      ).toEqual(asked);
      for (let i = 3; i < messages.length; i += 2) {
        expect(textOf(messages[i])).toBe(QUICK_REPLY);
      }
      // u1's reply was continued to its end, not left cut off.
      expect(textOf(messages[1])).toContain("chunk-29");
      tab2.close();
    },
    60_000
  );
});

describe("a turn started from onStart", () => {
  it("runs while onStart waits for it", async () => {
    const stub = await getAgentByName(
      env.OnStartTurnAgent,
      crypto.randomUUID()
    );
    // The first call starts the agent: onStart waits for its own turn.
    const roles = await Promise.race([
      stub.rolesForTest(),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("startup held"), 5000)
      )
    ]);
    expect(roles).toEqual(["user", "assistant"]);
  });
});
