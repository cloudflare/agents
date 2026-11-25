// What a Think tab draws while a message waits in the queue behind a reply.
//
// A request accepted while another turn runs holds its new user message
// until its turn starts. The server names it in `queuedMessageIds` on the
// message list. A tab draws it after the streaming reply, once, and keeps
// that order when the reply is stored and when the message joins.
import { StrictMode, Suspense, act } from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeAgent(name: string) {
  const target = new EventTarget();
  const sent: string[] = [];
  const agent = {
    _pkurl: `ws://localhost:3000/agents/chat/${name}?_pk=abc`,
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sent.push(data),
    dispatchEvent: target.dispatchEvent.bind(target),
    path: [{ agent: "Chat", name }],
    getHttpUrl: () => `http://localhost:3000/agents/chat/${name}`
  } as unknown as ReturnType<typeof useAgent>;
  const dispatch = (data: Record<string, unknown>) =>
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  const chunk = (id: string, body: Record<string, unknown> | null) =>
    dispatch({
      type: "cf_agent_use_chat_response",
      id,
      body: body ? JSON.stringify(body) : "",
      done: body === null
    });
  const list = (messages: UIMessage[], queuedMessageIds?: string[]) =>
    dispatch({
      type: "cf_agent_chat_messages",
      messages,
      ...(queuedMessageIds && { queuedMessageIds })
    });
  return { agent, sent, dispatch, chunk, list };
}

const u1: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Count to 40." }]
};
const u2: UIMessage = {
  id: "u2",
  role: "user",
  parts: [{ type: "text", text: "Say the word apple." }]
};

function textOf(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** The drawn list, as `id:text`. */
function drawn(messages: UIMessage[]): string[] {
  return messages.map((m) => `${m.id}:${textOf(m)}`);
}

async function mount(agent: ReturnType<typeof useAgent>) {
  const view: {
    messages: UIMessage[];
    chat?: ReturnType<typeof useAgentChat>;
  } = { messages: [] };
  const TestComponent = () => {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [] as UIMessage[],
      resume: false
    });
    view.messages = chat.messages;
    view.chat = chat;
    return <div>{chat.messages.length}</div>;
  };
  await act(async () => {
    render(<TestComponent />, {
      wrapper: ({ children }) => (
        <StrictMode>
          <Suspense fallback="Loading...">{children}</Suspense>
        </StrictMode>
      )
    });
    await sleep(10);
  });
  return view;
}

describe("a message queued behind a reply", () => {
  it("is drawn after a reply this tab watches, and the next reply after it", async () => {
    const { agent, dispatch, chunk, list } = fakeAgent("queued-observer");
    const view = await mount(agent);

    await act(async () => {
      list([u1]);
      dispatch({ type: "cf_agent_stream_resuming", id: "r1" });
      await sleep(10);
      chunk("r1", { type: "start", messageId: "a1" });
      chunk("r1", { type: "text-start", id: "t1" });
      chunk("r1", { type: "text-delta", id: "t1", delta: "1 2 " });
      await sleep(30);
    });
    await act(async () => {
      list([u1, u2], ["u2"]);
      chunk("r1", { type: "text-delta", id: "t1", delta: "3" });
      await sleep(30);
    });
    expect(drawn(view.messages)).toEqual([
      "u1:Count to 40.",
      "a1:1 2 3",
      "u2:Say the word apple."
    ]);

    const a1: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "1 2 3" }]
    };
    await act(async () => {
      chunk("r1", { type: "text-end", id: "t1" });
      chunk("r1", null);
      list([u1, a1, u2], ["u2"]);
      await sleep(30);
      // The queued request's turn: its question joins, its reply streams.
      list([u1, a1, u2]);
      chunk("r2", { type: "start", messageId: "a2" });
      chunk("r2", { type: "text-start", id: "t2" });
      chunk("r2", { type: "text-delta", id: "t2", delta: "apple" });
      await sleep(30);
    });
    expect(drawn(view.messages)).toEqual([
      "u1:Count to 40.",
      "a1:1 2 3",
      "u2:Say the word apple.",
      "a2:apple"
    ]);
  });

  it("goes when the server says it will not join", async () => {
    const { agent, list } = fakeAgent("queued-dropped");
    const view = await mount(agent);
    await act(async () => {
      list([u1, u2], ["u2"]);
      await sleep(30);
    });
    expect(view.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
    await act(async () => {
      list([u1]);
      await sleep(30);
    });
    expect(view.messages.map((m) => m.id)).toEqual(["u1"]);
  });
});
