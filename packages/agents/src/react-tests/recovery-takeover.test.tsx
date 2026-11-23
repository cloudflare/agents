/**
 * A request a recovery took over ends `aborted` (#3064). A tab can see that
 * end live before the cut-off stream's replayed chunks, or only as a
 * replayed end once it is back; either way it keeps one reply bubble and
 * nothing it can Stop is left pointing at the ended request.
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

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

const countType = (sent: string[], type: string) =>
  sent.filter((m) => {
    try {
      return (JSON.parse(m) as { type?: string }).type === type;
    } catch {
      return false;
    }
  }).length;

/** The frames a server replays for a turn of `deltaCount` text deltas. */
function replayFrames(requestId: string, deltaCount: number) {
  const bodies: Record<string, unknown>[] = [
    { messageId: "asst-1", type: "start" },
    { type: "start-step" },
    { id: "t1", type: "text-start" },
    ...Array.from({ length: deltaCount }, (_, i) => ({
      delta: `d${i} `,
      id: "t1",
      type: "text-delta"
    }))
  ];
  return bodies.map((body) => ({
    body: JSON.stringify(body),
    done: false,
    id: requestId,
    replay: true,
    type: CHAT_RESPONSE
  }));
}

async function mount(name: string) {
  const { agent, sentMessages, target } = createFakeAgent(name);
  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [
        { id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" }
      ] as UIMessage[]
    });
    return (
      <div>
        <div data-testid="assistants">
          {chat.messages.filter((m) => m.role === "assistant").length}
        </div>
        <div data-testid="status">{chat.status}</div>
        <button type="button" data-testid="stop" onClick={() => chat.stop()}>
          stop
        </button>
        <button
          type="button"
          data-testid="send"
          onClick={() => void chat.sendMessage({ text: "go" })}
        >
          send
        </button>
      </div>
    );
  }
  const { container } = await render(<TestComponent />);
  return {
    read: (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    click: (id: string) =>
      (container.querySelector(`[data-testid="${id}"]`) as HTMLElement).click(),
    sentMessages,
    target
  };
}

describe("a request a recovery took over", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    cleanup();
  });

  it("keeps one bubble when its live end arrives before its replayed chunks", async () => {
    const h = await mount("end-before-replay");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );
    dispatch(h.target, { id: "req-cut", type: RESUMING });
    await sleep(10);

    // The recovery closes the cut-off stream and ends the request live...
    dispatch(h.target, {
      body: "",
      done: true,
      id: "req-cut",
      outcome: "aborted",
      type: CHAT_RESPONSE
    });
    // ...then the replay the tab asked for arrives, and its end.
    for (const frame of replayFrames("req-cut", 5)) dispatch(h.target, frame);
    dispatch(h.target, {
      body: "",
      done: true,
      id: "req-cut",
      outcome: "aborted",
      replay: true,
      type: CHAT_RESPONSE
    });
    // The recovered turn continues the same reply under its own id.
    dispatch(h.target, {
      body: JSON.stringify({ type: "start", messageId: "asst-1" }),
      continuation: true,
      done: false,
      id: "req-cont",
      type: CHAT_RESPONSE
    });
    dispatch(h.target, {
      body: JSON.stringify({ delta: "more", id: "t2", type: "text-delta" }),
      continuation: true,
      done: false,
      id: "req-cont",
      type: CHAT_RESPONSE
    });
    dispatch(h.target, {
      body: "",
      continuation: true,
      done: true,
      id: "req-cont",
      type: CHAT_RESPONSE
    });
    await sleep(60);

    expect(h.read("assistants")).toBe("1");
  });

  it("leaves nothing to Stop once a replayed end says the request is over", async () => {
    const h = await mount("replayed-end-clears-stop");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );
    await sleep(20);
    h.click("send");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, "cf_agent_use_chat_request")).toBe(1)
    );
    const requestId = (
      h.sentMessages
        .map((m) => JSON.parse(m) as { type?: string; id?: string })
        .find((m) => m.type === "cf_agent_use_chat_request") ?? {}
    ).id;
    // The turn was cut off into recovery: "recovering" is not an end, so
    // Stop would still cancel it.
    dispatch(h.target, {
      body: "",
      done: true,
      id: requestId,
      outcome: "recovering",
      type: CHAT_RESPONSE
    });
    await sleep(20);
    // Later the server tells the tab how the request ended while it was
    // away (a recovery took it over).
    dispatch(h.target, {
      body: "",
      done: true,
      id: requestId,
      outcome: "aborted",
      replay: true,
      type: CHAT_RESPONSE
    });
    await sleep(30);

    const cancelsBefore = countType(
      h.sentMessages,
      "cf_agent_chat_request_cancel"
    );
    h.click("stop");
    await sleep(30);
    const cancels = h.sentMessages
      .map((m) => JSON.parse(m) as { type?: string; id?: string })
      .filter((m) => m.type === "cf_agent_chat_request_cancel")
      .slice(cancelsBefore);
    expect(cancels.some((m) => m.id === requestId)).toBe(false);
  });
});
