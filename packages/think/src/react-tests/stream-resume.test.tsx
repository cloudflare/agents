// Deterministic client-path coverage for Think's reconnect/resume handshake.
//
// Think is server-authoritative: on reconnect its `onConnect` proactively
// offers to resume an in-flight turn (CF_AGENT_STREAM_RESUMING) AND pushes the
// whole conversation transcript (CF_AGENT_CHAT_MESSAGES) — see
// `Think._buildIdleConnectMessages`. Both are consumed by the REAL
// `useAgentChat` hook that every Think client (Studio, starters) runs.
//
// These tests drive the real hook through the exact frame sequence Think emits,
// using the same fake `EventTarget` transport `studio-chat.test.tsx` uses, and
// lock three invariants:
//   1. A resume is ACKed exactly ONCE per stream even when the server announces
//      it twice (onConnect + the RESUME_REQUEST handler) — #1733.
//   2. The buffered turn is replayed in full and a duplicate replay does NOT
//      duplicate the assistant message.
//   3. The transcript pushed on an idle reconnect fully restores the message
//      list (Think's server-push model, deliberately divergent from ai-chat's
//      client-owned `getInitialMessages` — see the chat-recovery RFC).
//
// No browser, wrangler, Vite, or model — the live-socket dimension is covered
// by the agents `agent-tool-replay.test.tsx` real-Worker suite.
import { StrictMode, Suspense, act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

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

function countType(sentMessages: string[], type: string): number {
  return sentMessages
    .map((m) => JSON.parse(m) as { type?: string })
    .filter((m) => m.type === type).length;
}

const RESUMING = "cf_agent_stream_resuming";
const RESUME_ACK = "cf_agent_stream_resume_ack";
const CHAT_RESPONSE = "cf_agent_use_chat_response";
const CHAT_MESSAGES = "cf_agent_chat_messages";

function replayTurn(target: EventTarget, id: string) {
  dispatch(target, {
    type: CHAT_RESPONSE,
    id,
    body: '{"type":"start","messageId":"assistant-1"}',
    done: false,
    replay: true
  });
  dispatch(target, {
    type: CHAT_RESPONSE,
    id,
    body: '{"type":"text-start","id":"t1"}',
    done: false,
    replay: true
  });
  dispatch(target, {
    type: CHAT_RESPONSE,
    id,
    body: '{"type":"text-delta","id":"t1","delta":"Hello "}',
    done: false,
    replay: true
  });
  dispatch(target, {
    type: CHAT_RESPONSE,
    id,
    body: '{"type":"text-delta","id":"t1","delta":"world"}',
    done: false,
    replay: true
  });
}

describe("Think reconnect/resume handshake (client path)", () => {
  it("ACKs a resume exactly once and replays the turn without duplication", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "resume-ack",
      url: "ws://localhost:3000/agents/chat/resume-ack?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      const assistantText = chat.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("");
      const assistantCount = chat.messages.filter(
        (m) => m.role === "assistant"
      ).length;
      return (
        <div>
          <div data-testid="assistant-text">{assistantText}</div>
          <div data-testid="assistant-count">{assistantCount}</div>
        </div>
      );
    };

    await act(async () => {
      render(
        <StrictMode>
          <Suspense fallback="Loading...">
            <TestComponent />
          </Suspense>
        </StrictMode>
      );
      await sleep(10);
    });

    // Reconnect: Think announces the in-flight turn and replays its buffer.
    await act(async () => {
      dispatch(target, { type: RESUMING, id: "s1" });
      await sleep(10);
      replayTurn(target, "s1");
      await sleep(10);
    });

    // Think announces the SAME stream a second time (onConnect + the
    // RESUME_REQUEST handler both notify — #1733) and the buffer replays again.
    // The duplicate must neither re-ACK nor stack a second assistant copy.
    await act(async () => {
      dispatch(target, { type: RESUMING, id: "s1" });
      await sleep(10);
      replayTurn(target, "s1");
      dispatch(target, { type: CHAT_RESPONSE, id: "s1", body: "", done: true });
      await sleep(10);
    });

    await waitFor(() => {
      expect(screen.getByTestId("assistant-text").textContent).toBe(
        "Hello world"
      );
    });
    expect(screen.getByTestId("assistant-count").textContent).toBe("1");
    expect(countType(sentMessages, RESUME_ACK)).toBe(1);
  });

  it("restores the full transcript pushed on an idle reconnect", async () => {
    const { agent, target } = createFakeAgent({
      name: "transcript-restore",
      url: "ws://localhost:3000/agents/chat/transcript-restore?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      const text = chat.messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("|");
      return (
        <div>
          <div data-testid="count">{chat.messages.length}</div>
          <div data-testid="text">{text}</div>
        </div>
      );
    };

    await act(async () => {
      render(
        <StrictMode>
          <Suspense fallback="Loading...">
            <TestComponent />
          </Suspense>
        </StrictMode>
      );
      await sleep(10);
    });

    // No active stream — Think pushes the whole conversation on connect.
    await act(async () => {
      dispatch(target, {
        type: CHAT_MESSAGES,
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: "hello there" }]
          }
        ]
      });
      await sleep(10);
    });

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("2");
      expect(screen.getByTestId("text").textContent).toBe("hi|hello there");
    });
  });
});
