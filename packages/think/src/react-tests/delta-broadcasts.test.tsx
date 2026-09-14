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
const CHAT_RESPONSE = "cf_agent_use_chat_response";
const CLIENT_CAPABILITIES = "cf_agent_chat_client_capabilities";

function text(msg: string): UIMessage["parts"] {
  return [{ type: "text", text: msg }];
}

async function mount(name: string) {
  const { agent, target, sentMessages } = createFakeAgent({
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
  return {
    target,
    sentMessages,
    read: () => screen.getByTestId("transcript").textContent
  };
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

describe("Think client — delta capability negotiation", () => {
  it("declares transcriptDeltas on the socket, and again on every reopen", async () => {
    const { target, sentMessages } = await mount("delta-capabilities");

    const declarations = () =>
      sentMessages
        .map((m) => JSON.parse(m) as { type?: string; capabilities?: unknown })
        .filter((m) => m.type === CLIENT_CAPABILITIES);

    // The hook mounts before the socket opens in this harness, so nothing is
    // declared until the first `open`.
    await act(async () => {
      target.dispatchEvent(new Event("open"));
      await sleep(10);
    });
    expect(declarations()).toEqual([
      { type: CLIENT_CAPABILITIES, capabilities: { transcriptDeltas: true } }
    ]);

    // The server keys the capability by connection, so a reconnect must
    // re-declare it or the replacement socket silently falls back to
    // snapshots forever.
    await act(async () => {
      target.dispatchEvent(new Event("close"));
      target.dispatchEvent(new Event("open"));
      await sleep(10);
    });
    expect(declarations()).toHaveLength(2);
  });
});

describe("Think client — delta/snapshot parity", () => {
  it("adopts the server id for a row matched through a shared toolCallId", async () => {
    // The snapshot path replaces the list wholesale, so the client always ends
    // up on the server's ids. A delta must not leave the row pinned to a
    // locally minted id — regenerate/branch requests key on it.
    const { target, read } = await mount("delta-id-parity");

    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.9",
      messages: [
        { id: "u1", role: "user", parts: text("hi") },
        {
          id: "local-assistant",
          role: "assistant",
          parts: [
            {
              type: "tool-search",
              toolCallId: "call-1",
              state: "input-available",
              input: {}
            }
          ]
        }
      ]
    });
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.9",
      messages: [
        {
          id: "server-assistant",
          role: "assistant",
          parts: [
            {
              type: "tool-search",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: "done"
            },
            { type: "text", text: "found it" }
          ]
        }
      ]
    });
    await waitFor(() => expect(read()).toBe("u1:hi|server-assistant:found it"));
  });
});

describe("Think client — protected streaming assistant reconciles", () => {
  /** Drive the hook into an in-flight (protected) assistant stream. */
  async function startProtectedStream(target: EventTarget) {
    await act(async () => {
      target.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "cf_agent_stream_resuming", id: "s1" })
        })
      );
      await sleep(10);
    });
    for (const body of [
      '{"type":"start","messageId":"a1"}',
      '{"type":"text-start","id":"t1"}',
      '{"type":"text-delta","id":"t1","delta":"local copy"}'
    ]) {
      await dispatch(target, {
        type: CHAT_RESPONSE,
        id: "s1",
        body,
        done: false,
        replay: true
      });
    }
  }

  it("applies the persisted copy once the stream that owned it finishes", async () => {
    const { target, read } = await mount("delta-protected-reconcile");
    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.7",
      messages: [{ id: "u1", role: "user", parts: text("hi") }]
    });
    await startProtectedStream(target);
    await waitFor(() => expect(read()).toContain("a1:local copy"));

    // The cutover delta races ahead of the `finish` chunk. The locally
    // streamed copy is protected, so it stays — but the server's copy is
    // held, not dropped (on the snapshot path the next boundary's full frame
    // reconciles it; a delta naming only this row would be lost for good).
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.7",
      messages: [{ id: "a1", role: "assistant", parts: text("persisted") }]
    });
    expect(read()).toBe("u1:hi|a1:local copy");

    await dispatch(target, {
      type: CHAT_RESPONSE,
      id: "s1",
      body: "",
      done: true
    });
    await waitFor(() => expect(read()).toBe("u1:hi|a1:persisted"));
  });

  it("clears protection when the delta puts a later assistant after it (#1778)", async () => {
    const { target, read } = await mount("delta-protected-1778");
    await dispatch(target, {
      type: CHAT_MESSAGES,
      epoch: "inst.8",
      messages: [{ id: "u1", role: "user", parts: text("hi") }]
    });
    await startProtectedStream(target);
    await waitFor(() => expect(read()).toContain("a1:local copy"));

    // The server transcript advanced past the protected message (a HITL
    // denial persisted, then a follow-up assistant explaining it). Pinning
    // the local copy would reorder the transcript, so trust the server —
    // the same escape hatch the snapshot path takes.
    await dispatch(target, {
      type: CHAT_MESSAGES_DELTA,
      epoch: "inst.8",
      messages: [
        { id: "a1", role: "assistant", parts: text("denied") },
        { id: "a2", role: "assistant", parts: text("here is why") }
      ]
    });
    await waitFor(() => expect(read()).toBe("u1:hi|a1:denied|a2:here is why"));
  });
});
