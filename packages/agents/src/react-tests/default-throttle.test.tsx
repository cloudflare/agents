/**
 * `useAgentChat` throttles chat updates by default.
 *
 * Merging replayed chunks (#1913) removes one update per chunk, but a replayed
 * turn still costs about one update per part, so a turn with enough tool steps
 * reaches React's 50-render limit anyway. A throttle is independent of the
 * number of chunks, so it covers what merging cannot.
 *
 * The turn below is the shape that still failed after merging landed: 12 tool
 * steps, each with reasoning, a streamed tool input, a result, and a paragraph
 * of text.
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

const TOOL_STEPS = 12;
const WORDS_PER_STEP = 30;

/** The chunk bodies of an agentic turn: tool call, result, and text per step. */
function toolTurnBodies() {
  const bodies: Record<string, unknown>[] = [
    { messageId: "asst-1", type: "start" }
  ];
  for (let step = 0; step < TOOL_STEPS; step++) {
    bodies.push({ type: "start-step" });
    bodies.push({ id: `r${step}`, type: "reasoning-start" });
    for (let i = 0; i < 20; i++) {
      bodies.push({ delta: "think ", id: `r${step}`, type: "reasoning-delta" });
    }
    bodies.push({ id: `r${step}`, type: "reasoning-end" });
    bodies.push({
      toolCallId: `call-${step}`,
      toolName: "search",
      type: "tool-input-start"
    });
    for (let i = 0; i < 10; i++) {
      bodies.push({
        inputTextDelta: "x",
        toolCallId: `call-${step}`,
        type: "tool-input-delta"
      });
    }
    bodies.push({
      input: { q: "x" },
      toolCallId: `call-${step}`,
      toolName: "search",
      type: "tool-input-available"
    });
    bodies.push({
      output: { result: "ok" },
      toolCallId: `call-${step}`,
      type: "tool-output-available"
    });
    bodies.push({ id: `t${step}`, type: "text-start" });
    for (let i = 0; i < WORDS_PER_STEP; i++) {
      bodies.push({ delta: "word ", id: `t${step}`, type: "text-delta" });
    }
    bodies.push({ id: `t${step}`, type: "text-end" });
    bodies.push({ type: "finish-step" });
  }
  return bodies;
}

const expectedChars = TOOL_STEPS * WORDS_PER_STEP * "word ".length;

async function mount(name: string, throttle?: number | false) {
  const { agent, sentMessages, target } = createFakeAgent(name);

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [
        { id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" }
      ] as UIMessage[],
      throttle
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
    read: (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    sentMessages,
    target
  };
}

/** Replays a whole agentic turn in one task, as a resumed stream does. */
async function replayTurn(h: Awaited<ReturnType<typeof mount>>) {
  await vi.waitFor(() =>
    expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
  );
  dispatch(h.target, { id: "req-1", type: RESUMING });
  await sleep(10);

  for (const body of toolTurnBodies()) {
    dispatch(h.target, {
      body: JSON.stringify(body),
      done: false,
      id: "req-1",
      replay: true,
      type: CHAT_RESPONSE
    });
  }
  dispatch(h.target, {
    body: "",
    done: true,
    id: "req-1",
    type: CHAT_RESPONSE
  });
  await sleep(300);
}

describe("default chat throttle", () => {
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

  it("replays a tool-heavy turn without exceeding React's update depth", async () => {
    const h = await mount("throttle-default");
    await replayTurn(h);

    expect({
      chars: h.read("chars"),
      error: h.read("error"),
      status: h.read("status")
    }).toEqual({
      chars: String(expectedChars),
      error: "",
      status: "ready"
    });
  });

  // Proves the caller's value actually reaches the AI SDK: opting out restores
  // the unthrottled behaviour, and this turn is large enough to fail without a
  // throttle even with replayed chunks merged.
  it("lets a caller opt out with throttle: false", async () => {
    const h = await mount("throttle-off", false);
    await replayTurn(h);

    expect(h.read("status")).toBe("error");
  });
});
