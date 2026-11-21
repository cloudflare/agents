/**
 * A message sent while another turn runs waits on its request's admission
 * record, off the transcript, until its turn starts. The turn running now
 * never sees it, and the turn that answers it sees it last: `U1, A1, U2,
 * A2`. Tabs are shown it at once, named in `queuedMessageIds`.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

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

type Frame = {
  type: string;
  id?: string;
  done?: boolean;
  connect?: boolean;
  messages?: ChatMessage[];
  queuedMessageIds?: string[];
};

function record(ws: WebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    frames.push(JSON.parse(event.data as string));
  });
  return frames;
}

async function waitFor(ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(25);
  }
}

type Stub = {
  getPersistedMessages(): Promise<ChatMessage[]>;
  getTranscriptsSeenForTest(): Promise<string[][]>;
  waitForIdleForTest(): Promise<void>;
};

const SLOW = { chunkCount: 20, chunkDelayMs: 50 };
const QUICK = { chunkCount: 2, chunkDelayMs: 5 };

describe("a message queued behind a running turn", () => {
  it("joins the transcript when its turn starts, and tabs see it at once", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/slow-stream-agent/${room}`;
    const { ws: tabA } = await connectChatWS(path);
    const { ws: tabB } = await connectChatWS(path);
    const seenA = record(tabA);
    const seenB = record(tabB);
    const stub = (await getAgentByName(
      env.SlowStreamAgent,
      room
    )) as unknown as Stub;

    sendChatRequest(tabA, "r1", [user("u1", "Count to 40.")], SLOW);
    await waitFor(() =>
      seenA.some((f) => isUseChatResponseMessage(f) && f.id === "r1")
    );
    sendChatRequest(
      tabB,
      "r2",
      [user("u1", "Count to 40."), user("u2", "Say the word apple.")],
      QUICK
    );

    // Tab A is shown the question at once, after the transcript, queued.
    await waitFor(() =>
      seenA.some((f) => f.queuedMessageIds?.includes("u2") === true)
    );
    const shown = seenA.find((f) => f.queuedMessageIds?.includes("u2"));
    expect(shown?.messages?.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(shown?.queuedMessageIds).toEqual(["u2"]);
    // It is not stored yet.
    expect((await stub.getPersistedMessages()).map((m) => m.id)).toEqual([
      "u1"
    ]);

    // A tab that connects is sent it, named as queued. The HTTP transcript
    // holds what is stored.
    const loaded = (await (
      await exports.default.fetch(`http://example.com${path}/get-messages`)
    ).json()) as ChatMessage[];
    expect(loaded.map((m) => m.id)).toEqual(["u1"]);
    const { ws: tabC } = await connectChatWS(path);
    const seenC = record(tabC);
    await waitFor(() => seenC.some((f) => f.connect === true));
    expect(seenC.find((f) => f.connect)?.queuedMessageIds).toEqual(["u2"]);
    // Without the reply that streams: the tab gets it from the stream.
    expect(seenC.find((f) => f.connect)?.messages?.map((m) => m.id)).toEqual([
      "u1",
      "u2"
    ]);

    await waitFor(() =>
      seenA.some(
        (f) => isUseChatResponseMessage(f) && f.id === "r2" && f.done === true
      )
    );
    await stub.waitForIdleForTest();

    const stored = await stub.getPersistedMessages();
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(stored[2].id).toBe("u2");
    // The first turn never saw the question; the second sees it last.
    expect(await stub.getTranscriptsSeenForTest()).toEqual([
      ["u1"],
      ["u1", stored[1].id, "u2"]
    ]);
    // Once it joined, no list names it as queued.
    const last = seenA
      .filter((f) => f.type === "cf_agent_chat_messages")
      .at(-1);
    expect(last?.queuedMessageIds).toBeUndefined();
    expect(last?.messages?.filter((m) => m.id === "u2")).toHaveLength(1);
    // The tab that sent it was shown it as queued (with the first reply),
    // so it is told when it joins, too.
    const lists = seenB.filter((f) => f.type === "cf_agent_chat_messages");
    expect(lists.some((f) => f.queuedMessageIds?.includes("u2"))).toBe(true);
    expect(lists.at(-1)?.queuedMessageIds).toBeUndefined();
    tabA.close();
    tabB.close();
    tabC.close();
  }, 30_000);

  for (const end of ["stopped", "superseded"] as const) {
    it(`a request ${end} while it waits ends on its tab after the tab comes back`, async () => {
      const room = crypto.randomUUID();
      const path =
        end === "stopped"
          ? `/agents/slow-stream-agent/${room}`
          : `/agents/latest-message-concurrency-agent/${room}`;
      const { ws: tabA } = await connectChatWS(path);
      const { ws: tabB } = await connectChatWS(path);
      const seenB = record(tabB);
      sendChatRequest(tabB, "r1", [user("u1", "one")], SLOW);
      await waitFor(() =>
        seenB.some((f) => isUseChatResponseMessage(f) && f.id === "r1")
      );
      sendChatRequest(
        tabA,
        "r2",
        [user("u1", "one"), user("u2", "two")],
        QUICK
      );
      await delay(100);
      if (end === "stopped") {
        tabA.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
            id: "r2"
          })
        );
      } else {
        sendChatRequest(
          tabB,
          "r3",
          [user("u1", "one"), user("u2", "two"), user("u3", "three")],
          QUICK
        );
      }
      await delay(50);
      // The tab that sent r2 goes away before r2 ends.
      tabA.close();
      await waitFor(() =>
        seenB.some(
          (f) =>
            isUseChatResponseMessage(f) &&
            f.id === (end === "stopped" ? "r1" : "r3") &&
            f.done === true
        )
      );
      // It comes back and asks for r2 by id.
      const { ws: back } = await connectChatWS(path);
      const seen = record(back);
      back.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
          requestIds: ["r2"]
        })
      );
      await waitFor(() =>
        seen.some(
          (f) =>
            f.type === MessageType.CF_AGENT_STREAM_RESUMING && f.id === "r2"
        )
      );
      back.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: "r2"
        })
      );
      await waitFor(() =>
        seen.some((f) => isUseChatResponseMessage(f) && f.id === "r2" && f.done)
      );
      const done = seen.find(
        (f) => isUseChatResponseMessage(f) && f.id === "r2" && f.done
      ) as { outcome?: string };
      expect(done.outcome).toBe(end === "stopped" ? "aborted" : "skipped");
      tabB.close();
      back.close();
    }, 30_000);
  }

  it("a request whose admission record cannot be written ends with an error frame", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    const seen = record(ws);
    const stub = (await getAgentByName(
      env.SlowStreamAgent,
      room
    )) as unknown as {
      failNextAdmissionForTest(): Promise<void>;
    };
    await stub.failNextAdmissionForTest();
    sendChatRequest(ws, "r1", [user("u1", "one")], QUICK);
    await waitFor(() =>
      seen.some((f) => isUseChatResponseMessage(f) && f.id === "r1" && f.done)
    );
    const done = seen.find(
      (f) => isUseChatResponseMessage(f) && f.id === "r1" && f.done
    ) as { error?: boolean; body?: string };
    expect(done.error).toBe(true);
    expect(done.body).toContain("SQLITE_TOOBIG");
    ws.close();
  }, 30_000);

  it("a large message with a large body is accepted", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/test-chat-agent/${room}`;
    const { ws } = await connectChatWS(path);
    const seen = record(ws);
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "big",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [user("u-big", "漢".repeat(450_000))],
            big: "b".repeat(1_200_000)
          })
        }
      })
    );
    await waitFor(
      () =>
        seen.some(
          (f) => isUseChatResponseMessage(f) && f.id === "big" && f.done
        ),
      20_000
    );
    const stub = (await getAgentByName(
      env.TestChatAgent,
      room
    )) as unknown as Stub;
    expect((await stub.getPersistedMessages()).map((m) => m.id)).toContain(
      "u-big"
    );
    ws.close();
  }, 30_000);

  it("a clear while it waits drops it: it is never stored", async () => {
    const room = crypto.randomUUID();
    const path = `/agents/slow-stream-agent/${room}`;
    const { ws: tabA } = await connectChatWS(path);
    const seenA = record(tabA);
    const stub = (await getAgentByName(
      env.SlowStreamAgent,
      room
    )) as unknown as Stub;
    sendChatRequest(tabA, "r1", [user("u1", "one")], SLOW);
    await waitFor(() =>
      seenA.some((f) => isUseChatResponseMessage(f) && f.id === "r1")
    );
    sendChatRequest(tabA, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await delay(100);
    tabA.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await delay(300);
    await stub.waitForIdleForTest();
    expect(await stub.getPersistedMessages()).toEqual([]);
    tabA.close();
  }, 30_000);
});
