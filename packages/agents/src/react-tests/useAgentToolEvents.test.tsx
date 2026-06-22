/**
 * Browser tests for the `useAgentToolEvents` hook.
 *
 * The hook's whole job is to fold a stream of `agent-tool-event` frames into a
 * stable per-run view while surviving the two ways a frame can arrive twice:
 *   1. LIVE then REPLAY — the server re-sends a run's frames (same sequence
 *      numbers) to a reconnecting/late socket with `replay: true`.
 *   2. terminal then a stray `started` replay — the reducer must not resurrect a
 *      finished run.
 *
 * Dedupe is client-side and keyed by `(parentToolCallId, runId, sequence)` via a
 * `seenRef`, so it is exercised here with a fake `EventTarget` "agent" (the hook
 * only needs `addEventListener`/`removeEventListener`) — the same lightweight
 * pattern `@cloudflare/ai-chat` uses for `useAgentChat`. No Worker required.
 *
 * Locks the live-vs-replay dedupe invariant that previously had ZERO React-test
 * coverage.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { useAgentToolEvents } from "../react";
import type {
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolRunState
} from "../agent-tool-types";

// Async event dispatch lands outside act(), exactly like the real WebSocket
// path — mirror the agents `useAgent` suite and disable the act() environment
// after mount, then assert via `vi.waitFor` against a deterministic end-state.
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

type ToolAgent = Parameters<typeof useAgentToolEvents>[0]["agent"];

function createToolAgent(): {
  agent: ToolAgent;
  dispatch: (message: AgentToolEventMessage) => void;
  raw: (data: unknown) => void;
} {
  const target = new EventTarget();
  const agent = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  } as ToolAgent;
  const raw = (data: unknown) =>
    target.dispatchEvent(new MessageEvent("message", { data }));
  const dispatch = (message: AgentToolEventMessage) =>
    raw(JSON.stringify(message));
  return { agent, dispatch, raw };
}

function evt(
  sequence: number,
  event: AgentToolEvent,
  opts?: { parentToolCallId?: string; replay?: true }
): AgentToolEventMessage {
  return {
    type: "agent-tool-event",
    sequence,
    ...(opts?.parentToolCallId !== undefined && {
      parentToolCallId: opts.parentToolCallId
    }),
    ...(opts?.replay && { replay: true }),
    event
  };
}

type RenderedState = {
  runsById: Record<string, AgentToolRunState>;
  unboundRuns: AgentToolRunState[];
  runsByToolCallId: Record<string, AgentToolRunState[]>;
};

function Harness({
  agent,
  onReset
}: {
  agent: ToolAgent;
  onReset?: (reset: () => void) => void;
}) {
  const { runsById, unboundRuns, runsByToolCallId, resetLocalState } =
    useAgentToolEvents({ agent });
  onReset?.(resetLocalState);
  return (
    <div data-testid="state">
      {JSON.stringify({ runsById, unboundRuns, runsByToolCallId })}
    </div>
  );
}

function readState(container: HTMLElement): RenderedState {
  const text =
    container.querySelector('[data-testid="state"]')?.textContent ?? "{}";
  return JSON.parse(text) as RenderedState;
}

function runText(run: AgentToolRunState | undefined): string {
  if (!run) return "";
  return run.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

const TEXT_START = JSON.stringify({ type: "text-start", id: "t1" });
function delta(text: string): string {
  return JSON.stringify({ type: "text-delta", id: "t1", delta: text });
}

describe("useAgentToolEvents", () => {
  it("drops a REPLAY frame whose (parent, run, sequence) was already seen LIVE", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    // Live: start → text-start → "Hello"
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hello") }));

    // Replay the SAME seq-2 chunk (reconnect re-sends from the buffer), then a
    // genuinely new seq-3 chunk. If the replay were applied the text would read
    // "HelloHello world"; dedupe keeps it at "Hello world".
    dispatch(
      evt(
        2,
        { kind: "chunk", runId: "r1", body: delta("Hello") },
        { replay: true }
      )
    );
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta(" world") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hello world");
    });
  });

  it("applies distinct sequences for the same run (no over-dedupe)", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("foo") }));
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta("bar") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("foobar");
    });
  });

  it("ignores a stray `started` replay after the run reached a terminal", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "finished", runId: "r1", summary: "done" }));

    await vi.waitFor(() => {
      expect(readState(container).runsById.r1?.status).toBe("completed");
    });

    // A replayed `started` carries a NEW sequence (so the seenRef dedupe does
    // NOT drop it) — the reducer's terminal guard must keep the run `completed`
    // rather than resurrecting it to `running` or wiping its summary.
    dispatch(
      evt(
        2,
        { kind: "started", runId: "r1", agentType: "A", order: 0 },
        { replay: true }
      )
    );

    // Settle, then assert the terminal stuck.
    await new Promise((r) => setTimeout(r, 30));
    const run = readState(container).runsById.r1;
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("done");
  });

  it("re-applies replayed frames after resetLocalState() clears the seen set", async () => {
    const { agent, dispatch } = createToolAgent();
    let reset: () => void = () => {};
    const { container } = await render(
      <Harness agent={agent} onReset={(r) => (reset = r)} />
    );

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hi") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi");
    });

    // Reset (e.g. the consumer cleared local UI state on a hard reload).
    reset();
    await vi.waitFor(() => {
      expect(Object.keys(readState(container).runsById)).toHaveLength(0);
    });

    // The identical frames now re-apply — dedupe was cleared with the state.
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hi") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi");
    });
  });

  it("groups runs by parentToolCallId and surfaces parentless runs as unbound", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    // Two children of one tool call (distinct order) + one parentless run.
    dispatch(
      evt(
        0,
        { kind: "started", runId: "child-b", agentType: "A", order: 1 },
        { parentToolCallId: "call-1" }
      )
    );
    dispatch(
      evt(
        1,
        { kind: "started", runId: "child-a", agentType: "A", order: 0 },
        { parentToolCallId: "call-1" }
      )
    );
    dispatch(
      evt(2, { kind: "started", runId: "loose", agentType: "A", order: 0 })
    );

    await vi.waitFor(() => {
      const s = readState(container);
      expect(s.runsByToolCallId["call-1"]?.map((r) => r.runId)).toEqual([
        "child-a",
        "child-b"
      ]);
      expect(s.unboundRuns.map((r) => r.runId)).toEqual(["loose"]);
    });
  });

  it("reflects each terminal status (finished / error / aborted / interrupted)", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "ok", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "finished", runId: "ok", summary: "all good" }));
    dispatch(
      evt(2, { kind: "started", runId: "boom", agentType: "A", order: 1 })
    );
    dispatch(evt(3, { kind: "error", runId: "boom", error: "kaboom" }));
    dispatch(
      evt(4, { kind: "started", runId: "stop", agentType: "A", order: 2 })
    );
    dispatch(evt(5, { kind: "aborted", runId: "stop", reason: "cancelled" }));
    dispatch(
      evt(6, { kind: "started", runId: "evicted", agentType: "A", order: 3 })
    );
    dispatch(
      evt(7, {
        kind: "interrupted",
        runId: "evicted",
        error: "deploy evicted the child",
        reason: "no-progress",
        childStillRunning: true
      })
    );

    await vi.waitFor(() => {
      const { runsById } = readState(container);
      expect(runsById.ok?.status).toBe("completed");
      expect(runsById.ok?.summary).toBe("all good");
      expect(runsById.boom?.status).toBe("error");
      expect(runsById.boom?.error).toBe("kaboom");
      expect(runsById.stop?.status).toBe("aborted");
      expect(runsById.stop?.error).toBe("cancelled");
      expect(runsById.evicted?.status).toBe("interrupted");
      expect(runsById.evicted?.reason).toBe("no-progress");
      expect(runsById.evicted?.childStillRunning).toBe(true);
    });
  });

  it("ignores non-string and malformed frames without throwing", async () => {
    const { agent, dispatch, raw } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    raw(123); // non-string data
    raw("{ not json");
    raw(JSON.stringify({ type: "something-else" })); // wrong type
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );

    await vi.waitFor(() => {
      expect(readState(container).runsById.r1?.status).toBe("running");
    });
  });
});
