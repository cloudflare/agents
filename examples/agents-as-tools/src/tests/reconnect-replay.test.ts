/**
 * `Assistant.onConnect` helper-event replay.
 *
 * When a client connects (initial open or refresh), Think's
 * `_setupProtocolHandlers` wrapper sends the chat-protocol frames
 * (identity, state, `MSG_CHAT_MESSAGES`) first; the user's
 * `onConnect` runs after. Our override walks `cf_agent_helper_runs`
 * in `started_at` ascending order, and for each row:
 *
 *   - emits a synthesized `started` event from row data (sequence 0)
 *   - asks the helper sub-agent for its stored chat chunks via
 *     `getChatChunksForReplay`, emits each as a `chunk` event
 *     (sequences 1..N)
 *   - emits a synthesized terminal `finished`/`error` lifecycle event
 *     from row data (sequence N+1) — except for `running` rows,
 *     which the live broadcast loop will eventually finish.
 *
 * These tests pin down each branch of that contract. Seeding goes
 * through `TestAssistant.testSeedHelperRun`, which writes the
 * registry row with full lifecycle metadata (helperType, query,
 * summary, errorMessage) and, optionally, drives the helper's own
 * Think `_resumableStream` exactly the way production
 * `runTurnAndStream` does. So the replay assertions exercise the
 * production read path end-to-end without needing an AI binding.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { collectHelperEvents, connectWS, uniqueAssistantName } from "./helpers";
import type { HelperEventMessage } from "../protocol";
import type { Assistant } from "./worker";

async function freshAssistant(): Promise<{
  name: string;
  assistant: DurableObjectStub<Assistant>;
}> {
  const name = uniqueAssistantName();
  const assistant = await getAgentByName(env.Assistant, name);
  return { name, assistant };
}

function wsPath(name: string): string {
  return `/agents/assistant/${name}`;
}

/**
 * `terminate` predicate that stops collection on the first frame
 * matching `parentToolCallId` whose event kind is finished/error.
 */
function terminalForToolCall(
  parentToolCallId: string
): (frame: HelperEventMessage) => boolean {
  return (frame) =>
    frame.parentToolCallId === parentToolCallId &&
    frame.replay === true &&
    (frame.event.kind === "finished" || frame.event.kind === "error");
}

/** Sample `UIMessageChunk` bodies that match what Think's `_streamResult` emits. */
const CHUNK_TEXT_START = JSON.stringify({ type: "text-start", id: "t-1" });
const CHUNK_TEXT_DELTA = JSON.stringify({
  type: "text-delta",
  id: "t-1",
  delta: "Hello from helper."
});
const CHUNK_TEXT_END = JSON.stringify({ type: "text-end", id: "t-1" });

describe("Assistant.onConnect — empty registry", () => {
  it("does not emit any helper-event frames when no runs exist", async () => {
    const { name, assistant } = await freshAssistant();
    expect(await assistant.testReadHelperRuns()).toEqual([]);

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, { timeoutMs: 1000 });
      expect(frames).toEqual([]);
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — completed run replay", () => {
  it("emits started + chunks + finished with row's summary", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-c",
      parentToolCallId: "tc-c",
      helperType: "Researcher",
      query: "what is HTTP/3?",
      status: "completed",
      summary: "HTTP/3 is HTTP-over-QUIC.",
      chunks: [CHUNK_TEXT_START, CHUNK_TEXT_DELTA, CHUNK_TEXT_END]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 3000,
        terminate: terminalForToolCall("tc-c")
      });

      // 1 started + 3 chunks + 1 finished = 5 frames.
      expect(frames).toHaveLength(5);
      for (const f of frames) {
        expect(f.parentToolCallId).toBe("tc-c");
        expect(f.replay).toBe(true);
      }
      // Sequence is monotonic per helper.
      expect(frames.map((f) => f.sequence)).toEqual([0, 1, 2, 3, 4]);

      const [started, c0, c1, c2, finished] = frames;
      expect(started.event).toEqual({
        kind: "started",
        helperId: "h-c",
        helperType: "Researcher",
        query: "what is HTTP/3?",
        order: 0
      });
      expect(c0.event).toMatchObject({
        kind: "chunk",
        helperId: "h-c",
        body: CHUNK_TEXT_START
      });
      expect(c1.event).toMatchObject({ kind: "chunk", body: CHUNK_TEXT_DELTA });
      expect(c2.event).toMatchObject({ kind: "chunk", body: CHUNK_TEXT_END });
      expect(finished.event).toEqual({
        kind: "finished",
        helperId: "h-c",
        summary: "HTTP/3 is HTTP-over-QUIC."
      });
    } finally {
      ws.close();
    }
  });

  it("falls back to empty summary when the row has none", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-c-empty",
      parentToolCallId: "tc-c-empty",
      status: "completed",
      summary: null,
      chunks: [CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-c-empty")
      });
      const last = frames[frames.length - 1];
      expect(last.event.kind).toBe("finished");
      if (last.event.kind === "finished") {
        expect(last.event.summary).toBe("");
      }
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — running run replay", () => {
  it("emits started + chunks but no synthesized terminal", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-r",
      parentToolCallId: "tc-r",
      query: "in flight",
      status: "running",
      chunks: [CHUNK_TEXT_START, CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      // Use a short window — there is no terminal event to wait for.
      const frames = await collectHelperEvents(ws, { timeoutMs: 1500 });
      const forRun = frames.filter((f) => f.parentToolCallId === "tc-r");

      // 1 started + 2 chunks = 3 frames, no terminal.
      expect(forRun).toHaveLength(3);
      expect(forRun[0].event.kind).toBe("started");
      expect(forRun[1].event.kind).toBe("chunk");
      expect(forRun[2].event.kind).toBe("chunk");
      // No frame should be a terminal lifecycle event.
      for (const f of forRun) {
        expect(f.event.kind).not.toBe("error");
        expect(f.event.kind).not.toBe("finished");
      }
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — error run replay", () => {
  it("emits started + chunks + error using row's error_message", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-e1",
      parentToolCallId: "tc-e1",
      status: "error",
      errorMessage: "model returned 500",
      chunks: [CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-e1")
      });

      // 1 started + 1 chunk + 1 error = 3 frames.
      expect(frames).toHaveLength(3);
      const last = frames[frames.length - 1];
      expect(last.event.kind).toBe("error");
      if (last.event.kind === "error") {
        expect(last.event.error).toBe("model returned 500");
      }
    } finally {
      ws.close();
    }
  });

  it("uses a default error message when error_message is null", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-e2",
      parentToolCallId: "tc-e2",
      status: "error",
      errorMessage: null,
      chunks: [CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-e2")
      });

      const last = frames[frames.length - 1];
      expect(last.event.kind).toBe("error");
      if (last.event.kind === "error") {
        expect(last.event.error).toMatch(/before reporting a terminal event/i);
      }
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — interrupted run replay", () => {
  it("emits started + chunks + interrupted-error", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-i",
      parentToolCallId: "tc-i",
      status: "interrupted",
      chunks: [CHUNK_TEXT_START, CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-i")
      });

      // 1 started + 2 chunks + 1 error = 4 frames.
      expect(frames).toHaveLength(4);
      const last = frames[frames.length - 1];
      expect(last.event.kind).toBe("error");
      if (last.event.kind === "error") {
        expect(last.event.error).toMatch(/interrupted/i);
      }
    } finally {
      ws.close();
    }
  });

  it("emits started + interrupted-error even when the row has no chunks", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-i-empty",
      parentToolCallId: "tc-i-empty",
      status: "interrupted"
      // no chunks
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-i-empty")
      });

      // 1 started + 1 error.
      expect(frames).toHaveLength(2);
      expect(frames[0].event.kind).toBe("started");
      expect(frames[1].event.kind).toBe("error");
      expect(frames[1].sequence).toBe(1);
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — multiple runs", () => {
  it("replays runs in started_at ascending order, per-run sequence numbering", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "first",
      parentToolCallId: "tc-first",
      helperType: "Researcher",
      query: "q1",
      status: "completed",
      summary: "first done",
      startedAt: 100,
      completedAt: 110,
      chunks: [CHUNK_TEXT_DELTA]
    });
    await assistant.testSeedHelperRun({
      helperId: "second",
      parentToolCallId: "tc-second",
      helperType: "Researcher",
      query: "q2",
      status: "completed",
      summary: "second done",
      startedAt: 200,
      completedAt: 210,
      chunks: [CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 3000,
        terminate: terminalForToolCall("tc-second")
      });

      // Order: serialized per-run replay. First's all frames before
      // second's first frame.
      const firstIdxs = frames
        .map((f, i) => (f.parentToolCallId === "tc-first" ? i : -1))
        .filter((i) => i >= 0);
      const secondIdxs = frames
        .map((f, i) => (f.parentToolCallId === "tc-second" ? i : -1))
        .filter((i) => i >= 0);
      expect(firstIdxs.length).toBeGreaterThan(0);
      expect(secondIdxs.length).toBeGreaterThan(0);
      expect(Math.max(...firstIdxs)).toBeLessThan(Math.min(...secondIdxs));

      const firstFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-first"
      );
      const secondFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-second"
      );

      // Each: 1 started + 1 chunk + 1 finished.
      expect(firstFrames).toHaveLength(3);
      expect(secondFrames).toHaveLength(3);
      // Per-run sequence numbering starts at 0 for each.
      expect(firstFrames.map((f) => f.sequence)).toEqual([0, 1, 2]);
      expect(secondFrames.map((f) => f.sequence)).toEqual([0, 1, 2]);
    } finally {
      ws.close();
    }
  });

  it("replays a mixed-status set: completed + interrupted", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "ok",
      parentToolCallId: "tc-ok",
      status: "completed",
      summary: "fine",
      startedAt: 1,
      completedAt: 5,
      chunks: [CHUNK_TEXT_DELTA]
    });
    await assistant.testSeedHelperRun({
      helperId: "stuck",
      parentToolCallId: "tc-stuck",
      status: "interrupted",
      startedAt: 2,
      completedAt: 6,
      chunks: [CHUNK_TEXT_DELTA]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 3000,
        terminate: terminalForToolCall("tc-stuck")
      });

      const okFrames = frames.filter((f) => f.parentToolCallId === "tc-ok");
      const stuckFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-stuck"
      );

      // ok: started + chunk + finished
      expect(okFrames).toHaveLength(3);
      expect(okFrames.map((f) => f.event.kind)).toEqual([
        "started",
        "chunk",
        "finished"
      ]);

      // stuck: started + chunk + interrupted-error
      expect(stuckFrames).toHaveLength(3);
      expect(stuckFrames.map((f) => f.event.kind)).toEqual([
        "started",
        "chunk",
        "error"
      ]);
    } finally {
      ws.close();
    }
  });
});
