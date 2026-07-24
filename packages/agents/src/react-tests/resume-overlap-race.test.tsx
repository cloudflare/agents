/**
 * Regression test for #1837 — reconnect-driven resume overlap.
 *
 * With `resume: true` (the default), `useAgentChat` re-probes the stream from
 * its WebSocket `onAgentOpen` handler on every reconnect. The AI SDK's
 * `Chat.makeRequest` has NO concurrency guard: every resume shares the single
 * mutable `this.activeResponse`, and its `finally` finalizer reads
 * `this.activeResponse.state.message` with a BARE (unguarded) read before
 * clearing it. If a second resume overwrites + clears `activeResponse` before
 * an earlier resume's `finally` runs, the earlier finalizer reads `undefined`
 * and throws `TypeError: Cannot read properties of undefined (reading 'state')`
 * (caught + logged inside makeRequest's finally try/catch).
 *
 * The old `onAgentOpen` guard (`statusRef.current === "ready"` &&
 * `!isAwaitingResume()`) did not close the window, because:
 *   - `isAwaitingResume()` flips false the instant the resume handshake
 *     resolves (STREAM_RESUMING), but the AI SDK only sets status to
 *     "submitted" in a *later microtask* (behind `await reconnectToStream`), and
 *   - `statusRef.current` is lagging React state that hasn't re-rendered yet.
 *
 * So a socket `open` landing in that window (a reconnect storm: flaky mobile
 * link / DO bounce on redeploy) sailed past both guards and launched an
 * overlapping resume. The fix serializes resumes via `resumeInFlightRef`: no
 * new re-probe `resumeStream()` is issued while one is still outstanding.
 *
 * This drives the REAL hook through a fake `EventTarget` agent (no Worker
 * needed) using exactly the frames a reconnect storm produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import type { UIMessage } from "ai";
import type { useAgent } from "../react";
import { useAgentChat } from "../chat/react";

// Async WebSocket-driven updates legitimately land outside act() here; disable
// the act environment after mount (mirrors the other react-tests in this dir).
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeAgent({ name, url }: { name: string; url: string }) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const agent = {
    _pkurl: url,
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data),
    dispatchEvent: target.dispatchEvent.bind(target),
    path: [{ agent: "Chat", name }],
    getHttpUrl: () =>
      url.replace("ws://", "http://").replace("wss://", "https://")
  };
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    target,
    sentMessages
  };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

function open(target: EventTarget) {
  target.dispatchEvent(new Event("open"));
}

const RESUMING = "cf_agent_stream_resuming";
const RESUME_NONE = "cf_agent_stream_resume_none";
const RESUME_REQUEST = "cf_agent_stream_resume_request";
const CHAT_RESPONSE = "cf_agent_use_chat_response";

function countType(sentMessages: string[], type: string): number {
  return sentMessages
    .map((m) => {
      try {
        return JSON.parse(m) as { type?: string };
      } catch {
        return {};
      }
    })
    .filter((m) => m.type === type).length;
}

describe("reconnect-driven resume overlap (#1837)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    cleanup();
  });

  it("serializes overlapping resumes and never reads a cleared activeResponse", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "overlap",
      url: "ws://localhost:3000/agents/chat/overlap?_pk=abc"
    });

    function TestComponent() {
      useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return <div data-testid="ok">ok</div>;
    }

    await render(<TestComponent />);
    await sleep(10);

    // Settle the AI SDK's mount-time resume so the chat is at "ready" and the
    // transport is no longer awaiting a resume (isAwaitingResume() === false).
    dispatch(target, { type: RESUME_NONE });
    await sleep(10);

    // First "open" is consumed by the hook's first-open gate (hasConnectedOnce).
    open(target);
    await sleep(10);

    // A real reconnect: the re-probe fires resume A (sends a RESUME_REQUEST).
    open(target);
    await sleep(10);

    // Server announces resume A. The handshake resolves SYNCHRONOUSLY here, so
    // isAwaitingResume() flips false immediately — but the AI SDK only sets
    // status to "submitted" in a *later microtask*. A second "open" dispatched
    // in the same synchronous turn therefore sees statusRef === "ready" AND
    // isAwaitingResume() === false. Pre-fix this launched an overlapping resume
    // B; post-fix `resumeInFlightRef` suppresses it.
    const requestsBeforeOverlap = countType(sentMessages, RESUME_REQUEST);
    dispatch(target, { type: RESUMING, id: "s1" });
    open(target); // overlapping reconnect — no await before this
    await sleep(10);
    const requestsAfterOverlap = countType(sentMessages, RESUME_REQUEST);

    // Server announces a second stream id (the would-be overlapping resume B).
    dispatch(target, { type: RESUMING, id: "s2" });
    await sleep(10);

    // B settles first and clears the shared activeResponse...
    dispatch(target, { type: CHAT_RESPONSE, id: "s2", body: "", done: true });
    await sleep(10);

    // ...then A's finalizer runs. Pre-fix it read the now-undefined
    // activeResponse and threw.
    dispatch(target, { type: CHAT_RESPONSE, id: "s1", body: "", done: true });
    await sleep(10);

    const captured = (errorSpy.mock.calls.flat() as unknown[]).map(
      (a: unknown) => (a instanceof Error ? a.message : String(a))
    );
    const sawStateTypeError = captured.some((m: string) =>
      /reading 'state'|Cannot read properties of undefined/.test(m)
    );

    // The overlapping reconnect must not issue a second resume...
    expect(requestsAfterOverlap).toBe(requestsBeforeOverlap);
    // ...and the AI SDK finalizer must never read a cleared activeResponse.
    expect(sawStateTypeError).toBe(false);
  });
});
