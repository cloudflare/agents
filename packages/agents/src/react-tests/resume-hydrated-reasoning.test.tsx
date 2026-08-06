/**
 * Regression test for reasoning parts duplicating on stream resume.
 *
 * On reconnect the server hydrates the persisted turn (`cf_agent_chat_messages`)
 * and then replays the whole turn from its first chunk. The hook clears the
 * hydrated assistant so replay can rebuild it, and collapses any part that
 * survives the race with its rebuilt copy.
 *
 * That collapse only considered `text` parts, so a hydrated reasoning block and
 * its replayed copy both stayed in the message: the UI showed the model's
 * thinking twice for every reconnect.
 */
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as _render } from "vitest-browser-react";
import { useAgentChat } from "../chat/react";
import type { useAgent } from "../react";

const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESUMING = "cf_agent_stream_resuming";
const RESUME_REQUEST = "cf_agent_stream_resume_request";
const CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_ID = "asst-1";

function createFakeAgent(name: string) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const url = `ws://localhost:3000/agents/chat/${name}?_pk=abc`;
  const agent = {
    _pk: name,
    _pkurl: url,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    dispatchEvent: target.dispatchEvent.bind(target),
    getHttpUrl: () => url.replace("ws://", "http://"),
    id: "fake-agent",
    name,
    path: [{ agent: "Chat", name }],
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data)
  };
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    sentMessages,
    target
  };
}

const dispatch = (target: EventTarget, data: Record<string, unknown>) =>
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );

const countType = (sent: string[], type: string) =>
  sent.filter((m) => {
    try {
      return (JSON.parse(m) as { type?: string }).type === type;
    } catch {
      return false;
    }
  }).length;

/** A turn that thinks, then answers. */
function replayFrames(requestId: string) {
  const bodies: Record<string, unknown>[] = [
    { messageId: MSG_ID, type: "start" },
    { id: "r1", type: "reasoning-start" },
    { delta: "I should count. ", id: "r1", type: "reasoning-delta" },
    { delta: "This is long.", id: "r1", type: "reasoning-delta" },
    { id: "r1", type: "reasoning-end" },
    { id: "t1", type: "text-start" }
  ];
  for (let i = 1; i <= 20; i++) {
    bodies.push({ delta: `${i} `, id: "t1", type: "text-delta" });
  }
  bodies.push({ id: "t1", type: "text-end" });
  return bodies.map((body) => ({
    body: JSON.stringify(body),
    done: false,
    id: requestId,
    replay: true,
    type: CHAT_RESPONSE
  }));
}

/** What the server persisted before the socket dropped: thinking + partial text. */
const hydratedMessages: UIMessage[] = [
  { id: "user-1", parts: [{ text: "count", type: "text" }], role: "user" },
  {
    id: MSG_ID,
    parts: [
      { text: "I should count. ", type: "reasoning" },
      { text: "1 2 3 4 5 ", type: "text" }
    ],
    role: "assistant"
  }
];

function Harness({ agent }: { agent: ReturnType<typeof useAgent> }) {
  const { messages } = useAgentChat({ agent, getInitialMessages: null });
  const assistant = messages.filter((m) => m.role === "assistant");
  const parts = assistant.flatMap((m) => m.parts);
  return (
    <div>
      <span data-testid="assistant-count">{assistant.length}</span>
      <span data-testid="reasoning-count">
        {parts.filter((p) => p.type === "reasoning").length}
      </span>
      <span data-testid="text-count">
        {parts.filter((p) => p.type === "text").length}
      </span>
      <span data-testid="reasoning">
        {parts
          .filter((p) => p.type === "reasoning")
          .map((p) => ("text" in p ? p.text : ""))
          .join("|")}
      </span>
    </div>
  );
}

describe("replay after hydration", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => cleanup());

  it("collapses a hydrated reasoning part into its replayed rebuild", async () => {
    const h = createFakeAgent("probe-reasoning");
    const screen = await render(<Harness agent={h.agent} />);
    const read = (id: string) =>
      screen.container.querySelector(`[data-testid="${id}"]`)?.textContent ??
      "";

    // The server hydrates the persisted, partially complete turn on connect.
    dispatch(h.target, {
      messages: hydratedMessages,
      type: "cf_agent_chat_messages"
    });
    await sleep(50);

    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBeGreaterThan(0)
    );
    dispatch(h.target, { id: "req-1", type: RESUMING });
    await sleep(10);

    for (const frame of replayFrames("req-1")) dispatch(h.target, frame);
    dispatch(h.target, {
      body: "",
      done: false,
      id: "req-1",
      replay: true,
      replayComplete: true,
      type: CHAT_RESPONSE
    });
    await sleep(150);

    expect({
      assistants: read("assistant-count"),
      reasoning: read("reasoning-count"),
      text: read("text-count"),
      reasoningText: read("reasoning")
    }).toEqual({
      assistants: "1",
      reasoning: "1",
      text: "1",
      reasoningText: "I should count. This is long."
    });
  });
});
