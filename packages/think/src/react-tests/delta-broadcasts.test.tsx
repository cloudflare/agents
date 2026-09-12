// Client-side contract for Think's transcript deltas.
//
// Think broadcasts a full `cf_agent_chat_messages` snapshot on connect/resume
// and `cf_agent_chat_messages_delta` frames (only the rows a turn boundary
// persisted) during normal operation. A delta is tagged with the `epoch` of
// the snapshot it applies to. These tests drive the REAL `useAgentChat` hook
// through frame sequences and lock the ordering guard:
//   1. A delta that arrives before any snapshot is dropped (the tab has no
//      base to apply it to; the server owes it a snapshot).
//   2. A delta whose epoch does not match the last snapshot's is dropped.
//   3. A matching delta upserts by id and appends unknown ids in order.
//   4. A later snapshot with a new epoch replaces the list and re-keys the
//      guard, so deltas for the old epoch are ignored from then on.
import { StrictMode, Suspense, act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";

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

async function dispatch(target: EventTarget, data: Record<string, unknown>) {
  await act(async () => {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
    await sleep(10);
  });
}

const CHAT_MESSAGES = "cf_agent_chat_messages";
const CHAT_MESSAGES_DELTA = "cf_agent_chat_messages_delta";

function text(msg: string): UIMessage["parts"] {
  return [{ type: "text", text: msg }];
}

async function mount(name: string) {
  const { agent, target } = createFakeAgent({
    name,
    url: `ws://localhost:3000/agents/chat/${name}?_pk=abc`
  });
  const TestComponent = () => {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [] as UIMessage[]
    });
    const rendered = chat.messages
      .map(
        (m) =>
          `${m.id}:${m.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text?: string }).text ?? "")
            .join("")}`
      )
      .join("|");
    return <div data-testid="transcript">{rendered}</div>;
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
  return { target, read: () => screen.getByTestId("transcript").textContent };
}

describe("Think client — transcript delta ordering guard", () => {
  it("drops a delta that arrives before any snapshot", async () => {
    const { target, read } = await mount("delta-before-snapshot");

    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.1",
      messages: [{ id: "u1", role: "user", parts: text("early") }]
    });
    expect(read()).toBe("");

    // The snapshot the server owes this tab lands; from then on deltas apply.
    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.1",
      messages: [{ id: "u1", role: "user", parts: text("hi") }]
    });
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.1",
      messages: [{ id: "a1", role: "assistant", parts: text("hello") }]
    });
    await waitFor(() => expect(read()).toBe("u1:hi|a1:hello"));
  });

  it("drops a delta whose epoch does not match the last snapshot", async () => {
    const { target, read } = await mount("delta-wrong-epoch");

    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.2",
      messages: [{ id: "u1", role: "user", parts: text("hi") }]
    });
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.1",
      messages: [{ id: "a1", role: "assistant", parts: text("stale") }]
    });
    expect(read()).toBe("u1:hi");

    // A delta from a previous DO instance (different prefix) is stale too.
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "other.2",
      messages: [{ id: "a1", role: "assistant", parts: text("stale") }]
    });
    expect(read()).toBe("u1:hi");
  });

  it("applies a matching delta as an upsert by id, appending unknown ids", async () => {
    const { target, read } = await mount("delta-upsert");

    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.3",
      messages: [
        { id: "u1", role: "user", parts: text("hi") },
        { id: "a1", role: "assistant", parts: text("partial") }
      ]
    });
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.3",
      messages: [
        { id: "a1", role: "assistant", parts: text("final") },
        { id: "u2", role: "user", parts: text("next") },
        { id: "a2", role: "assistant", parts: text("reply") }
      ]
    });
    await waitFor(() => expect(read()).toBe("u1:hi|a1:final|u2:next|a2:reply"));
  });

  it("re-keys the guard when a newer snapshot lands", async () => {
    const { target, read } = await mount("delta-rekey");

    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.1",
      messages: [{ id: "u1", role: "user", parts: text("hi") }]
    });
    // The server re-derived its transcript (compaction/clear/branch): a new
    // epoch snapshot replaces the list wholesale.
    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.2",
      messages: [{ id: "s1", role: "user", parts: text("summary") }]
    });
    await waitFor(() => expect(read()).toBe("s1:summary"));

    // A delta minted for the old base is ignored…
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.1",
      messages: [{ id: "a1", role: "assistant", parts: text("old") }]
    });
    expect(read()).toBe("s1:summary");
    // …while one for the new base applies.
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.2",
      messages: [{ id: "a2", role: "assistant", parts: text("new") }]
    });
    await waitFor(() => expect(read()).toBe("s1:summary|a2:new"));
  });

  it("treats an epoch-less snapshot (older server) as accepting no deltas", async () => {
    const { target, read } = await mount("delta-no-epoch");

    await dispatch(target, {
      type: CHAT_MESSAGES,
      messages: [{ id: "u1", role: "user", parts: text("hi") }]
    });
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.1",
      messages: [{ id: "a1", role: "assistant", parts: text("nope") }]
    });
    expect(read()).toBe("u1:hi");
  });
});
