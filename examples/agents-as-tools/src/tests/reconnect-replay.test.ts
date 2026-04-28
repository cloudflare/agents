/**
 * `Assistant.onConnect` helper-event replay.
 *
 * When a client connects (initial open or refresh), Think's
 * `_setupProtocolHandlers` wrapper sends the chat-protocol frames
 * (identity, state, `MSG_CHAT_MESSAGES`) first; the user's
 * `onConnect` runs after. Our override walks `cf_agent_helper_runs`
 * in `started_at` ascending order, asks each helper sub-agent for its
 * stored events via `getStoredEventsForRun`, and forwards each event
 * to the connecting client as a `helper-event` frame with
 * `replay: true`. For runs whose status is `interrupted` (or `error`
 * with no stored terminal event), it appends a synthetic terminal
 * `error` event so the UI can stop rendering a "Running…" panel.
 *
 * These tests pin down each branch of that contract. Seeding goes
 * through `TestAssistant.testSeedHelperRun`, which writes the
 * registry row directly and (optionally) drives the helper's
 * `ResumableStream` exactly the way production `startAndStream` does
 * — so the replay assertions exercise the production read path
 * end-to-end without needing an AI binding to drive the helper.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { collectHelperEvents, connectWS, uniqueAssistantName } from "./helpers";
import type { HelperEvent, HelperEventMessage } from "../protocol";
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
 * matching `parentToolCallId` whose event kind is finished/error and
 * `replay` is set. Used by tests that know the expected last event
 * to exit early.
 */
function terminalForToolCall(
  parentToolCallId: string
): (frame: HelperEventMessage) => boolean {
  return (frame) =>
    frame.parentToolCallId === parentToolCallId &&
    frame.replay === true &&
    (frame.event.kind === "finished" || frame.event.kind === "error");
}

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
  it("replays every stored event in order with replay: true", async () => {
    const { name, assistant } = await freshAssistant();

    const events: HelperEvent[] = [
      {
        kind: "started",
        helperId: "h-c",
        helperType: "Researcher",
        query: "q"
      },
      { kind: "step", helperId: "h-c", step: 1, description: "Plan" },
      { kind: "step", helperId: "h-c", step: 2, description: "Search" },
      { kind: "finished", helperId: "h-c", summary: "all done." }
    ];

    await assistant.testSeedHelperRun({
      helperId: "h-c",
      parentToolCallId: "tc-c",
      status: "completed",
      events
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 3000,
        terminate: terminalForToolCall("tc-c")
      });

      expect(frames).toHaveLength(events.length);
      for (let i = 0; i < events.length; i++) {
        expect(frames[i].type).toBe("helper-event");
        expect(frames[i].parentToolCallId).toBe("tc-c");
        expect(frames[i].sequence).toBe(i);
        expect(frames[i].replay).toBe(true);
        expect(frames[i].event).toEqual(events[i]);
      }
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — running run replay", () => {
  it("replays in-progress events without appending a synthetic terminal", async () => {
    const { name, assistant } = await freshAssistant();

    const events: HelperEvent[] = [
      {
        kind: "started",
        helperId: "h-r",
        helperType: "Researcher",
        query: "q"
      },
      { kind: "step", helperId: "h-r", step: 1, description: "Working" }
    ];

    await assistant.testSeedHelperRun({
      helperId: "h-r",
      parentToolCallId: "tc-r",
      status: "running",
      events
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      // Use a short window — there is no terminal event to wait for.
      const frames = await collectHelperEvents(ws, { timeoutMs: 1500 });
      const forRun = frames.filter((f) => f.parentToolCallId === "tc-r");

      expect(forRun).toHaveLength(events.length);
      for (let i = 0; i < events.length; i++) {
        expect(forRun[i].sequence).toBe(i);
        expect(forRun[i].replay).toBe(true);
        expect(forRun[i].event.kind).not.toBe("error");
        expect(forRun[i].event.kind).not.toBe("finished");
      }
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — error run replay", () => {
  it("does not append a synthetic terminal when a terminal error is already stored", async () => {
    const { name, assistant } = await freshAssistant();

    const events: HelperEvent[] = [
      {
        kind: "started",
        helperId: "h-e1",
        helperType: "Researcher",
        query: "q"
      },
      { kind: "error", helperId: "h-e1", error: "boom" }
    ];

    await assistant.testSeedHelperRun({
      helperId: "h-e1",
      parentToolCallId: "tc-e1",
      status: "error",
      events
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-e1")
      });

      expect(frames).toHaveLength(events.length);
      // Only one error frame — the stored one. No synthetic.
      const errors = frames.filter((f) => f.event.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].event.kind === "error" && errors[0].event.error).toBe(
        "boom"
      );
    } finally {
      ws.close();
    }
  });

  it("appends a synthetic terminal error when status is 'error' but no terminal was stored", async () => {
    const { name, assistant } = await freshAssistant();

    const events: HelperEvent[] = [
      {
        kind: "started",
        helperId: "h-e2",
        helperType: "Researcher",
        query: "q"
      },
      { kind: "step", helperId: "h-e2", step: 1, description: "Working" }
    ];

    await assistant.testSeedHelperRun({
      helperId: "h-e2",
      parentToolCallId: "tc-e2",
      status: "error",
      events
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-e2")
      });

      expect(frames).toHaveLength(events.length + 1);
      const last = frames[frames.length - 1];
      expect(last.event.kind).toBe("error");
      expect(last.replay).toBe(true);
      // Synthetic terminal sits at lastSequence + 1.
      expect(last.sequence).toBe(events.length);
      if (last.event.kind === "error") {
        expect(last.event.helperId).toBe("h-e2");
        expect(last.event.error).toMatch(/before reporting a terminal event/i);
      }
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — interrupted run replay", () => {
  it("appends a synthetic 'interrupted' terminal when no terminal was stored", async () => {
    const { name, assistant } = await freshAssistant();

    const events: HelperEvent[] = [
      {
        kind: "started",
        helperId: "h-i",
        helperType: "Researcher",
        query: "q"
      },
      { kind: "step", helperId: "h-i", step: 1, description: "Working" },
      { kind: "step", helperId: "h-i", step: 2, description: "Searching" }
    ];

    await assistant.testSeedHelperRun({
      helperId: "h-i",
      parentToolCallId: "tc-i",
      status: "interrupted",
      events
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-i")
      });

      expect(frames).toHaveLength(events.length + 1);
      const last = frames[frames.length - 1];
      expect(last.event.kind).toBe("error");
      expect(last.replay).toBe(true);
      expect(last.sequence).toBe(events.length);
      if (last.event.kind === "error") {
        expect(last.event.error).toMatch(/interrupted/i);
      }
    } finally {
      ws.close();
    }
  });

  it("appends a synthetic terminal even when the registry row has no events", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "h-i-empty",
      parentToolCallId: "tc-i-empty",
      status: "interrupted"
      // no events
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 2000,
        terminate: terminalForToolCall("tc-i-empty")
      });

      expect(frames).toHaveLength(1);
      expect(frames[0].event.kind).toBe("error");
      expect(frames[0].replay).toBe(true);
      expect(frames[0].sequence).toBe(0);
    } finally {
      ws.close();
    }
  });
});

describe("Assistant.onConnect — multiple runs", () => {
  it("replays runs in started_at ascending order", async () => {
    const { name, assistant } = await freshAssistant();

    await assistant.testSeedHelperRun({
      helperId: "first",
      parentToolCallId: "tc-first",
      status: "completed",
      startedAt: 100,
      completedAt: 110,
      events: [
        {
          kind: "started",
          helperId: "first",
          helperType: "Researcher",
          query: "q1"
        },
        { kind: "finished", helperId: "first", summary: "first done" }
      ]
    });
    await assistant.testSeedHelperRun({
      helperId: "second",
      parentToolCallId: "tc-second",
      status: "completed",
      startedAt: 200,
      completedAt: 210,
      events: [
        {
          kind: "started",
          helperId: "second",
          helperType: "Researcher",
          query: "q2"
        },
        { kind: "finished", helperId: "second", summary: "second done" }
      ]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 3000,
        terminate: terminalForToolCall("tc-second")
      });

      // The first run's frames must all arrive before any of the
      // second's, since onConnect serializes per-run replay.
      const firstIdx = frames.findIndex(
        (f) => f.parentToolCallId === "tc-first"
      );
      const lastFirstIdx = frames
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.parentToolCallId === "tc-first")
        .pop()?.i;
      const firstSecondIdx = frames.findIndex(
        (f) => f.parentToolCallId === "tc-second"
      );
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(lastFirstIdx).toBeLessThan(firstSecondIdx);

      const firstFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-first"
      );
      const secondFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-second"
      );
      expect(firstFrames).toHaveLength(2);
      expect(secondFrames).toHaveLength(2);

      // Each run keeps its own per-run sequence numbering starting at 0.
      expect(firstFrames.map((f) => f.sequence)).toEqual([0, 1]);
      expect(secondFrames.map((f) => f.sequence)).toEqual([0, 1]);
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
      startedAt: 1,
      completedAt: 5,
      events: [
        {
          kind: "started",
          helperId: "ok",
          helperType: "Researcher",
          query: "q"
        },
        { kind: "finished", helperId: "ok", summary: "fine" }
      ]
    });
    await assistant.testSeedHelperRun({
      helperId: "stuck",
      parentToolCallId: "tc-stuck",
      status: "interrupted",
      startedAt: 2,
      completedAt: 6,
      events: [
        {
          kind: "started",
          helperId: "stuck",
          helperType: "Researcher",
          query: "q"
        }
      ]
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

      expect(okFrames).toHaveLength(2);
      expect(okFrames.map((f) => f.event.kind)).toEqual([
        "started",
        "finished"
      ]);

      // Interrupted run: stored started + synthetic terminal error.
      expect(stuckFrames).toHaveLength(2);
      expect(stuckFrames.map((f) => f.event.kind)).toEqual([
        "started",
        "error"
      ]);
      expect(stuckFrames[1].sequence).toBe(1);
    } finally {
      ws.close();
    }
  });
});
