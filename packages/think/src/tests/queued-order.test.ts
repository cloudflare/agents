/**
 * A message sent while another turn runs waits on its request's admission
 * record, off the session, until its turn starts. The turn running now
 * never sees it, and the turn that answers it sees it last: `U1, A1, U2,
 * A2`, with `U2` a child of `A1`. Tabs are shown it at once, named in
 * `queuedMessageIds`.
 */
import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

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
      frames.push(JSON.parse(event.data as string));
    } catch {
      // not JSON
    }
  });
  return frames;
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

describe("a message queued behind a running turn", () => {
  it("joins the session when its turn starts, and tabs see it at once", async () => {
    const binding = "ThinkAdmissionTestAgent";
    const room = crypto.randomUUID();
    const tabA = await connect(binding, room);
    const tabB = await connect(binding, room);
    const seenA = record(tabA);
    const seenB = record(tabB);
    const stub = await agent(binding, room);

    send(tabA, "r1", [user("u1", "one")], SLOW);
    await waitFor(
      async () =>
        seenA.some((f) => f.type === MSG_CHAT_RESPONSE && f.id === "r1"),
      (ok) => ok
    );
    send(tabB, "r2", [user("u1", "one"), user("u2", "two")], QUICK);
    await waitFor(
      async () =>
        seenA.find(
          (f) =>
            Array.isArray(f.queuedMessageIds) &&
            (f.queuedMessageIds as string[]).includes("u2")
        ),
      (f) => f !== undefined
    );
    const shown = seenA.find((f) => Array.isArray(f.queuedMessageIds));
    expect(((shown?.messages ?? []) as UIMessage[]).map((m) => m.id)).toEqual([
      "u1",
      "u2"
    ]);
    expect(shown?.queuedMessageIds).toEqual(["u2"]);
    expect((await stub.getMessagesForTest()).map((m) => m.id)).toEqual(["u1"]);

    // A tab that connects is sent it, named as queued.
    const tabC = await connect(binding, room);
    const seenC = record(tabC);
    await waitFor(
      async () => seenC.find((f) => f.connect === true),
      (f) => f !== undefined,
      5000
    );
    expect(seenC.find((f) => f.connect === true)?.queuedMessageIds).toEqual([
      "u2"
    ]);
    // Without the reply that streams: the tab gets it from the stream.
    expect(
      (
        (seenC.find((f) => f.connect === true)?.messages ?? []) as UIMessage[]
      ).map((m) => m.id)
    ).toEqual(["u1", "u2"]);
    const loaded = (await (
      await exports.default.fetch(
        `http://example.com/agents/think-admission-test-agent/${room}/get-messages`
      )
    ).json()) as UIMessage[];
    // The HTTP transcript holds what is stored.
    expect(loaded.map((m) => m.id)).toEqual(["u1"]);

    const messages = await waitFor(
      () => stub.getMessagesForTest(),
      (m) => m.some((x) => textOf(x) === QUICK_REPLY)
    );
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(messages[2].id).toBe("u2");
    expect(textOf(messages[1]).startsWith("s0 ")).toBe(true);
    // The first turn never saw the question; the second sees it last.
    const requests = await stub.getModelRequestsForTest();
    expect(requests).toHaveLength(2);
    expect(requests[0].some((m) => m.text.includes("two"))).toBe(false);
    expect(requests[1].at(-1)?.role).toBe("user");
    expect(requests[1].at(-1)?.text).toContain("two");
    expect(requests[1].map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user"
    ]);
    // The tab that sent it is never left drawing it as queued.
    await delay(300);
    const lists = seenB.filter((f) => f.type === "cf_agent_chat_messages");
    expect(lists.at(-1)?.queuedMessageIds).toBeUndefined();
    tabA.close();
    tabB.close();
    tabC.close();
  }, 40_000);
});
