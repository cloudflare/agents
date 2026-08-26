/**
 * Regression test for #1913.
 *
 * Resuming a long turn replays every stored chunk as its own
 * `cf_agent_use_chat_response` frame. Before the replay batch landed, the
 * transport-owned resume path forwarded each frame into the UI-message stream
 * individually, so chat state — and therefore React — was updated once per
 * chunk. Past ~50 consecutive updates React's nested-update guard throws
 * "Maximum update depth exceeded", `useChat` catches it, and the client shows a
 * terminal `status: "error"` for a turn the server completed fine.
 *
 * These cases drive the real hook with the exact wire frames a resume produces
 * and assert the client stays healthy. They live in the react project because
 * that is the only layer where the failure is observable: the throw comes from
 * React's commit loop, not from the transport.
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

type Harness = {
  read: (id: string) => string | null | undefined;
  sentMessages: string[];
  target: EventTarget;
};

async function mount(name: string): Promise<Harness> {
  const { agent, sentMessages, target } = createFakeAgent(name);

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [
        { id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" }
      ] as UIMessage[]
    });
    const assistantText = chat.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    return (
      <div>
        <div data-testid="status">{chat.status}</div>
        <div data-testid="error">{String(chat.error?.message ?? "")}</div>
        <div data-testid="chars">{assistantText.length}</div>
      </div>
    );
  }

  const { container } = await render(<TestComponent />);
  return {
    read: (id) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    sentMessages,
    target
  };
}

/** Text length the assistant message should have after `deltaCount` deltas. */
const expectedChars = (deltaCount: number) =>
  Array.from({ length: deltaCount }, (_, i) => `d${i} `).join("").length;

describe("#1913 — resume replay burst", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    cleanup();
  });

  // 400 deltas is ~8x React's nested-update ceiling; 60 is just past it, and
  // was the smallest burst that failed before the fix.
  it.each([{ deltas: 60 }, { deltas: 400 }])(
    "applies a $deltas-delta replay burst without exceeding React's update depth",
    async ({ deltas }) => {
      const h = await mount(`replay-${deltas}`);
      await vi.waitFor(() =>
        expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
      );

      dispatch(h.target, { id: "req-1", type: RESUMING });
      await sleep(10);

      // The whole burst arrives in one task, exactly as replayChunks() sends it.
      for (const frame of replayFrames("req-1", deltas)) {
        dispatch(h.target, frame);
      }
      dispatch(h.target, {
        body: "",
        done: true,
        id: "req-1",
        type: CHAT_RESPONSE
      });
      await sleep(60);

      expect({
        chars: h.read("chars"),
        error: h.read("error"),
        status: h.read("status")
      }).toEqual({
        chars: String(expectedChars(deltas)),
        error: "",
        status: "ready"
      });
    }
  );

  it("shows a replayed burst that is not followed by a terminator", async () => {
    // A burst is coalesced only for the turn of the event loop that delivers
    // it. Nothing may wait on `replayComplete` or `done` to become visible,
    // and no content may be held across the frames that drive the hook's own
    // replay bookkeeping.
    const h = await mount("replay-no-terminator");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );

    dispatch(h.target, { id: "req-open", type: RESUMING });
    await sleep(10);

    for (const frame of replayFrames("req-open", 120)) {
      dispatch(h.target, frame);
    }
    await sleep(60);

    expect({
      chars: h.read("chars"),
      error: h.read("error")
    }).toEqual({
      chars: String(expectedChars(120)),
      error: ""
    });
  });

  it("keeps replayed content when the socket closes during the burst", async () => {
    // A second disconnect can arrive before the coalescing window closes.
    // Content already received must not be lost — it was visible before the
    // batch existed, because each chunk was enqueued on arrival and a closed
    // stream still yields whatever it has queued.
    const h = await mount("replay-close");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );

    dispatch(h.target, { id: "req-close", type: RESUMING });
    await sleep(10);

    for (const frame of replayFrames("req-close", 120)) {
      dispatch(h.target, frame);
    }
    h.target.dispatchEvent(new Event("close"));
    await sleep(60);

    expect({
      chars: h.read("chars"),
      error: h.read("error")
    }).toEqual({
      chars: String(expectedChars(120)),
      error: ""
    });
  });

  it("keeps replayed content when the resumed turn ends in an error", async () => {
    const h = await mount("replay-error");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );

    dispatch(h.target, { id: "req-err", type: RESUMING });
    await sleep(10);

    for (const frame of replayFrames("req-err", 120)) {
      dispatch(h.target, frame);
    }
    // #1575: partial content is replayed, then the terminal error frame.
    dispatch(h.target, {
      body: "model exploded",
      done: true,
      error: true,
      id: "req-err",
      type: CHAT_RESPONSE
    });
    await sleep(60);

    expect({
      chars: h.read("chars"),
      error: h.read("error"),
      status: h.read("status")
    }).toEqual({
      chars: String(expectedChars(120)),
      error: "model exploded",
      status: "error"
    });
  });

  it("delivers live chunks after a replayed burst in order", async () => {
    const h = await mount("replay-then-live");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );

    dispatch(h.target, { id: "req-live", type: RESUMING });
    await sleep(10);

    for (const frame of replayFrames("req-live", 80)) {
      dispatch(h.target, frame);
    }
    dispatch(h.target, {
      body: "",
      done: false,
      id: "req-live",
      replay: true,
      replayComplete: true,
      type: CHAT_RESPONSE
    });
    await sleep(20);

    // Replayed prefix is applied at the boundary, before any live chunk.
    expect(h.read("chars")).toBe(String(expectedChars(80)));

    dispatch(h.target, {
      body: JSON.stringify({ delta: "LIVE", id: "t1", type: "text-delta" }),
      done: false,
      id: "req-live",
      type: CHAT_RESPONSE
    });
    dispatch(h.target, {
      body: "",
      done: true,
      id: "req-live",
      type: CHAT_RESPONSE
    });
    await sleep(60);

    expect({
      chars: h.read("chars"),
      error: h.read("error"),
      status: h.read("status")
    }).toEqual({
      chars: String(expectedChars(80) + "LIVE".length),
      error: "",
      status: "ready"
    });
  });
});
