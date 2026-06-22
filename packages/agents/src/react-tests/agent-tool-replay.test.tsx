/**
 * Real-Worker integration tests for agent-tool replay-on-reconnect.
 *
 * The companion `useAgentToolEvents.test.tsx` proves the client dedupe reducer
 * in isolation against a fake event source. This suite proves the SAME
 * invariant end-to-end over a real WebSocket against a real Durable Object:
 *
 *   - The server replays a run's frames on every `onConnect`
 *     (`Agent._replayAgentToolRuns`) with `replay: true`, numbering them from
 *     the parent's monotonic counter (`started`@0, chunks@1..N, terminal@N+1).
 *   - A FRESH client reconstructs the whole run from replay alone (proving
 *     replay actually delivers the full sequence).
 *   - The SAME client that already saw the run LIVE dedupes the replay across a
 *     real `reconnect()` — no doubled parts — which only holds if the live and
 *     replay wire sequences match exactly.
 *   - The #1630 typed interrupted cause (`reason` / `childStillRunning`)
 *     survives the wire replay to a client (previously covered server-side only
 *     via `captureReplayTerminalEventsForTest`).
 *
 * Driven by the deterministic, LLM-free `TestAgentToolStubChild` via the
 * `TestAgentToolReplayAgent.runDeterministicAgentToolForTest` RPC.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { useEffect } from "react";
import { useAgent, useAgentToolEvents, type UseAgentOptions } from "../react";
import type { AgentToolRunState } from "../agent-tool-types";
import { getTestWorkerHost } from "./test-config";

// Async WebSocket updates legitimately land outside act() — disable the act
// environment after mount and assert via `vi.waitFor`, mirroring the other
// real-Worker suites in this directory.
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- tests don't need strict agent typing
type ReplayAgent = ReturnType<typeof useAgent<any>>;

type RenderedState = {
  runsById: Record<string, AgentToolRunState>;
  unboundRuns: AgentToolRunState[];
  runsByToolCallId: Record<string, AgentToolRunState[]>;
};

function Harness({
  options,
  onAgent
}: {
  options: UseAgentOptions;
  onAgent?: (agent: ReplayAgent) => void;
}) {
  const agent = useAgent(options);
  const { runsById, unboundRuns, runsByToolCallId } = useAgentToolEvents({
    agent
  });

  useEffect(() => {
    onAgent?.(agent);
  }, [agent, agent.identified, onAgent]);

  return (
    <div>
      <div data-testid="agent-status">
        {agent.identified ? "connected" : "connecting"}
      </div>
      <div data-testid="tool-state">
        {JSON.stringify({ runsById, unboundRuns, runsByToolCallId })}
      </div>
    </div>
  );
}

function readState(container: HTMLElement): RenderedState {
  const text =
    container.querySelector('[data-testid="tool-state"]')?.textContent ?? "{}";
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
const CHUNK_BODIES = [TEXT_START, delta("Hello"), delta(" world")];
const EXPECTED_TEXT = "Hello world";

async function mount(name: string): Promise<{
  container: HTMLElement;
  getAgent: () => ReplayAgent;
}> {
  const { host, protocol } = getTestWorkerHost();
  let captured: ReplayAgent | null = null;
  const { container } = await render(
    <Harness
      options={{ agent: "TestAgentToolReplayAgent", name, host, protocol }}
      onAgent={(a) => {
        captured = a;
      }}
    />
  );
  await vi.waitFor(
    () => {
      expect(
        container.querySelector('[data-testid="agent-status"]')?.textContent
      ).toBe("connected");
    },
    { timeout: 10000 }
  );
  return { container, getAgent: () => captured! };
}

describe("agent-tool replay over a real Worker", () => {
  it("replays a completed run in full to a fresh (late-joining) client", async () => {
    const name = `replay-late-${crypto.randomUUID()}`;
    const runId = "run-late";
    const parentToolCallId = "call-late";

    // Driver connection: trigger the run, wait for it to complete LIVE.
    const driver = await mount(name);
    const result = await driver
      .getAgent()
      .call("runDeterministicAgentToolForTest", [
        { runId, parentToolCallId, chunkBodies: CHUNK_BODIES, summary: "done" }
      ]);
    // Surface any server-side failure directly (otherwise we only see a status
    // mismatch after the waitFor times out).
    expect((result as { status: string }).status, JSON.stringify(result)).toBe(
      "completed"
    );
    await vi.waitFor(
      () => {
        const run = readState(driver.container).runsById[runId];
        expect(run?.status).toBe("completed");
        expect(runText(run)).toBe(EXPECTED_TEXT);
      },
      { timeout: 10000 }
    );

    // Fresh observer connects AFTER completion: its only source of the run is
    // the server's `onConnect` replay. A fresh client has an empty dedupe set,
    // so it applies every replayed frame — proving replay delivers the full
    // `started` + chunks + terminal sequence.
    const observer = await mount(name);
    await vi.waitFor(
      () => {
        const run = readState(observer.container).runsById[runId];
        expect(run?.status).toBe("completed");
        expect(runText(run)).toBe(EXPECTED_TEXT);
        expect(run?.summary).toBe("done");
      },
      { timeout: 10000 }
    );
  });

  it("dedupes the replay across a real reconnect (no doubled parts)", async () => {
    const name = `replay-reconnect-${crypto.randomUUID()}`;
    const runId = "run-reconnect";
    const parentToolCallId = "call-reconnect";

    const { container, getAgent } = await mount(name);
    await getAgent().call("runDeterministicAgentToolForTest", [
      { runId, parentToolCallId, chunkBodies: CHUNK_BODIES, summary: "done" }
    ]);
    await vi.waitFor(
      () => {
        const run = readState(container).runsById[runId];
        expect(run?.status).toBe("completed");
        expect(runText(run)).toBe(EXPECTED_TEXT);
      },
      { timeout: 10000 }
    );

    // Drop and re-open the socket. The server replays the run with `replay:
    // true` using the SAME wire sequences the client already saw live; the
    // hook's persistent `seenRef` must drop every one. If the replay used
    // different sequence numbers the text would become "HelloHello world..." —
    // so a stable single copy is a real wire-sequence + dedupe guarantee.
    getAgent().reconnect();
    await vi.waitFor(
      () => {
        expect(
          container.querySelector('[data-testid="agent-status"]')?.textContent
        ).toBe("connected");
      },
      { timeout: 10000 }
    );

    // Let any replay frames flush, then assert nothing doubled.
    await new Promise((r) => setTimeout(r, 250));
    const finalState = readState(container);
    expect(Object.keys(finalState.runsById)).toEqual([runId]);
    expect(runText(finalState.runsById[runId])).toBe(EXPECTED_TEXT);
    expect(finalState.runsById[runId]?.status).toBe("completed");
  });

  it("preserves the typed interrupted cause across a wire replay", async () => {
    const name = `replay-interrupted-${crypto.randomUUID()}`;
    const runId = "run-interrupted";

    // Seed a stranded `interrupted` row through the real persist path (what
    // parent recovery writes when it gives up re-attaching to a live child),
    // then observe it from a fresh client whose only source is the replay.
    const driver = await mount(name);
    await driver
      .getAgent()
      .call("seedInterruptedRunForTest", [runId, "no-progress", true]);

    const observer = await mount(name);
    await vi.waitFor(
      () => {
        const run = readState(observer.container).runsById[runId];
        expect(run?.status).toBe("interrupted");
        expect(run?.reason).toBe("no-progress");
        expect(run?.childStillRunning).toBe(true);
      },
      { timeout: 10000 }
    );
  });
});
