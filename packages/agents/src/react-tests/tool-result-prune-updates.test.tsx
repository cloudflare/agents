/**
 * The `clientToolResults` stale-entry cleanup effect must not schedule a state
 * update when there is nothing stale to remove.
 *
 * The effect runs on every `chatMessages` change. Calling `setClientToolResults`
 * unconditionally and relying on the updater returning `prev` is not free:
 * React only takes the eager-bailout path when the fiber has no pending work,
 * and during a live stream the next chunk has usually already scheduled some.
 * The effect is passive, and a SyncLane commit flushes passive effects inside
 * the commit itself, so each dispatch lands on DefaultLane while
 * `root.pendingLanes` is still non-empty -- the condition under which React
 * increments `nestedUpdateCount` instead of resetting it. That counter is a
 * monotonic accumulator, so one dispatch per streamed chunk reaches the limit
 * of 50 on a long answer and React throws "Maximum update depth exceeded".
 *
 * The turn below streams chunk-per-task, the way a live socket delivers them,
 * rather than replaying a whole turn in one task like `default-throttle`.
 *
 * Two details are load-bearing, and dropping either makes this pass against the
 * unfixed code rather than failing:
 *
 *   1. The component must cost something to render (`RENDER_COST_MS`). With a
 *      trivial component React drains its queue between chunks, every commit
 *      ends idle, and the counter resets instead of accumulating.
 *   2. The frames must be queued as separate tasks up front rather than awaited
 *      one at a time. Awaiting between chunks hands React a clear main thread
 *      and has the same masking effect.
 *
 * Calibration: against the unfixed effect this fails on every attempt, including
 * all of the project's configured retries; with the fix it passes first try.
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

/**
 * Comfortably past React's limit of 50 nested updates. Each delta is delivered
 * in its own task, so with the throttle off each one is its own commit and --
 * before the fix -- its own counted cleanup dispatch.
 */
const TEXT_DELTAS = 120;
const DELTA = "word ";

/**
 * Per-render cost standing in for a real transcript, which re-parses and
 * re-renders the whole growing markdown body on every chunk. It is what keeps
 * React from draining its queue between chunks, so `root.pendingLanes` is still
 * non-empty when each commit ends -- the condition that makes React accumulate
 * `nestedUpdateCount` rather than reset it. Without a render cost React settles
 * after every chunk and the counter never climbs, which is why a trivial
 * component cannot reproduce this.
 */
const RENDER_COST_MS = 3;

function burnRenderBudget() {
  const until = performance.now() + RENDER_COST_MS;
  while (performance.now() < until) {
    // Intentionally synchronous: the point is to occupy the main thread the way
    // a real markdown re-render does, so queued socket messages pile up behind it.
  }
}

async function mount(name: string) {
  const { agent, sentMessages, target } = createFakeAgent(name);

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [
        { id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" }
      ] as UIMessage[],
      // The throttle is what previously masked this by lowering the commit
      // rate; turn it off so the test measures the effect and not the throttle.
      throttle: false
    });
    burnRenderBudget();
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
    read: (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    sentMessages,
    target
  };
}

/** Streams a turn one chunk per task, the way a live socket delivers them. */
async function streamTurn(h: Awaited<ReturnType<typeof mount>>) {
  await vi.waitFor(() =>
    expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
  );
  dispatch(h.target, { id: "req-1", type: RESUMING });
  await sleep(10);

  const send = (body: Record<string, unknown>) =>
    dispatch(h.target, {
      body: JSON.stringify(body),
      done: false,
      id: "req-1",
      type: CHAT_RESPONSE
    });

  // Queue every frame as its own task up front. They interleave with React's
  // scheduler slices exactly as socket messages do during a live turn: React
  // yields, a queued message dispatches another update, and the root never
  // reaches an idle commit.
  const frames: Record<string, unknown>[] = [
    { messageId: "asst-1", type: "start" },
    { type: "start-step" },
    { id: "t1", type: "text-start" }
  ];
  for (let i = 0; i < TEXT_DELTAS; i++) {
    frames.push({ delta: DELTA, id: "t1", type: "text-delta" });
  }
  frames.push({ id: "t1", type: "text-end" });
  frames.push({ type: "finish-step" });

  await new Promise<void>((resolve) => {
    for (const [index, frame] of frames.entries()) {
      setTimeout(() => {
        send(frame);
        if (index === frames.length - 1) {
          resolve();
        }
      }, 0);
    }
  });

  dispatch(h.target, {
    body: "",
    done: true,
    id: "req-1",
    type: CHAT_RESPONSE
  });
  await sleep(500);
}

describe("clientToolResults cleanup", () => {
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

  it("streams a long turn without exceeding React's update depth", async () => {
    const h = await mount("tool-result-prune");
    await streamTurn(h);

    expect({
      chars: h.read("chars"),
      error: h.read("error"),
      status: h.read("status")
    }).toEqual({
      chars: String(TEXT_DELTAS * DELTA.length),
      error: "",
      status: "ready"
    });
  });
});
