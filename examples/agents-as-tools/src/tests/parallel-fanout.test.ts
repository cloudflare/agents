/**
 * Parallel helper fan-out — drives two `runResearchHelper` calls
 * concurrently against a single Assistant DO and verifies the
 * `(parentToolCallId, helperId)` demux holds under real concurrency.
 *
 * Two patterns are exercised:
 *
 *   - **Alpha**: two helpers with **different** `parentToolCallId`s,
 *     simulating the LLM dispatching two `research` tool calls in
 *     parallel during one turn (AI SDK's `parallel_tool_calls`
 *     default). Each helper renders under its own chat tool part.
 *
 *   - **Beta**: two helpers with the **same** `parentToolCallId`,
 *     simulating the `compare` tool's `Promise.all` fan-out from a
 *     single tool call. Both helpers render as siblings under one
 *     chat tool part (image 3 in
 *     cloudflare/agents#1377-comment-4328296343).
 *
 * Both patterns rely on the parent's `_broadcastHelperEvent` not
 * interleaving frames in a way that confuses per-helper sequence
 * numbering. Each helper has its own monotonic sequence
 * (`0..N` per helper run), and the dedup key on the wire is
 * `(parentToolCallId, helperId, sequence)`.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import {
  collectHelperEvents,
  connectWS,
  startCollectingHelperEvents,
  uniqueAssistantName
} from "./helpers";
// `collectHelperEvents` is used by the replay test below. The Alpha/
// Beta tests use `startCollectingHelperEvents` instead because they
// need to capture frames broadcast during a `Promise.all` that
// completes before the test would otherwise start awaiting.
import type { HelperEventMessage } from "../protocol";
import type { Assistant } from "./worker";
import { MOCK_HELPER_RESPONSE } from "./worker";

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

/** Group frames by the helper that emitted them (carried inside `event.helperId`). */
function groupByHelper(
  frames: HelperEventMessage[]
): Record<string, HelperEventMessage[]> {
  const out: Record<string, HelperEventMessage[]> = {};
  for (const f of frames) {
    const id = f.event.helperId;
    if (!out[id]) out[id] = [];
    out[id].push(f);
  }
  return out;
}

describe("parallel fan-out — Alpha (different parentToolCallId)", () => {
  it("two concurrent helpers under distinct tool calls each complete and the broadcasts demux cleanly", async () => {
    const { name, assistant } = await freshAssistant();

    const { ws } = await connectWS(wsPath(name));
    // Start collecting BEFORE driving the helpers — the broadcasts
    // happen synchronously during `Promise.all` and a once-listener
    // collector would miss them.
    const { frames, stop } = startCollectingHelperEvents(ws);
    try {
      // Drive both helpers concurrently via the test seam, with
      // different parentToolCallIds (the Alpha pattern: two
      // separate chat tool calls in the parent's turn).
      const [resA, resB] = await Promise.all([
        assistant.testRunResearchHelper("HTTP/3 head-of-line blocking", "tc-a"),
        assistant.testRunResearchHelper("gRPC vs REST tradeoffs", "tc-b")
      ]);
      expect(resA.summary).toBe(MOCK_HELPER_RESPONSE);
      expect(resB.summary).toBe(MOCK_HELPER_RESPONSE);

      // Both must end up as `completed` rows with distinct ids.
      const rows = await assistant.testReadHelperRuns();
      expect(rows).toHaveLength(2);
      const byTc = Object.fromEntries(
        rows.map((r) => [r.parent_tool_call_id, r])
      );
      expect(byTc["tc-a"].status).toBe("completed");
      expect(byTc["tc-b"].status).toBe("completed");
      expect(byTc["tc-a"].helper_id).not.toBe(byTc["tc-b"].helper_id);

      const aFrames = frames.filter((f) => f.parentToolCallId === "tc-a");
      const bFrames = frames.filter((f) => f.parentToolCallId === "tc-b");

      // Each tool call's stream must include at least started + chunks + finished.
      expect(aFrames.some((f) => f.event.kind === "started")).toBe(true);
      expect(aFrames.some((f) => f.event.kind === "finished")).toBe(true);
      expect(bFrames.some((f) => f.event.kind === "started")).toBe(true);
      expect(bFrames.some((f) => f.event.kind === "finished")).toBe(true);

      // Per-tool-call sequences must be monotonic (each run's
      // `_broadcastHelperEvent` increments its own counter).
      for (const list of [aFrames, bFrames]) {
        for (let i = 1; i < list.length; i++) {
          expect(list[i].sequence).toBeGreaterThan(list[i - 1].sequence);
        }
      }
    } finally {
      stop();
      ws.close();
    }
  }, 20_000);
});

describe("parallel fan-out — Beta (same parentToolCallId)", () => {
  it("two concurrent helpers under one tool call demux per helperId on the live broadcast", async () => {
    const { name, assistant } = await freshAssistant();

    const { ws } = await connectWS(wsPath(name));
    const { frames, stop } = startCollectingHelperEvents(ws);
    try {
      // Drive both helpers concurrently with the SAME parentToolCallId
      // — the `compare` tool's pattern: one chat tool call dispatches
      // both helpers via Promise.all. Pass distinct `displayOrder`s
      // so each helper's `started` event carries the right `order`
      // for the client to sort on.
      await Promise.all([
        assistant.testRunResearchHelper("topic-a", "tc-shared", 0),
        assistant.testRunResearchHelper("topic-b", "tc-shared", 1)
      ]);

      // Two rows in the registry, both sharing the parent tool call id,
      // both `completed` with distinct helper ids and distinct
      // display_order values matching what we passed in.
      const rows = await assistant.testReadHelperRuns();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.parent_tool_call_id).toBe("tc-shared");
        expect(row.status).toBe("completed");
      }
      expect(rows[0].helper_id).not.toBe(rows[1].helper_id);
      expect(rows.map((r) => r.display_order).sort()).toEqual([0, 1]);

      // Frames on the live broadcast must split cleanly per helper.
      const liveFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-shared"
      );

      const byHelper = groupByHelper(liveFrames);
      const helperIds = Object.keys(byHelper);
      expect(helperIds).toHaveLength(2);

      const seenOrders = new Set<number>();
      for (const id of helperIds) {
        const list = byHelper[id];
        // Each helper's frames must include lifecycle bookends.
        expect(list[0].event.kind).toBe("started");
        expect(list[list.length - 1].event.kind).toBe("finished");
        // Each helper's sequences are monotonic from 0.
        for (let i = 0; i < list.length; i++) {
          expect(list[i].sequence).toBe(i);
        }
        // Started carries the explicit `order` field that the client
        // sorts on. Each helper's order must be unique within the bucket.
        const started = list[0].event;
        expect(started.kind).toBe("started");
        if (started.kind === "started") {
          expect(seenOrders.has(started.order)).toBe(false);
          seenOrders.add(started.order);
        }
      }
      expect([...seenOrders].sort()).toEqual([0, 1]);
    } finally {
      stop();
      ws.close();
    }
  }, 20_000);

  it("three concurrent helpers under one tool call all complete and demux", async () => {
    const { name, assistant } = await freshAssistant();

    const { ws } = await connectWS(wsPath(name));
    const { frames, stop } = startCollectingHelperEvents(ws);
    try {
      // Stress N>2: three concurrent helpers under the same
      // parentToolCallId. The wire-format triple
      // (parentToolCallId, helperId, sequence) must still uniquely
      // identify every event with no collisions.
      await Promise.all([
        assistant.testRunResearchHelper("topic-a", "tc-trio", 0),
        assistant.testRunResearchHelper("topic-b", "tc-trio", 1),
        assistant.testRunResearchHelper("topic-c", "tc-trio", 2)
      ]);

      const rows = await assistant.testReadHelperRuns();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.parent_tool_call_id).toBe("tc-trio");
        expect(row.status).toBe("completed");
      }
      expect(new Set(rows.map((r) => r.helper_id)).size).toBe(3);
      expect(rows.map((r) => r.display_order).sort()).toEqual([0, 1, 2]);

      const liveFrames = frames.filter((f) => f.parentToolCallId === "tc-trio");
      const byHelper = groupByHelper(liveFrames);
      expect(Object.keys(byHelper)).toHaveLength(3);
      for (const id of Object.keys(byHelper)) {
        const list = byHelper[id];
        expect(list[0].event.kind).toBe("started");
        expect(list[list.length - 1].event.kind).toBe("finished");
        for (let i = 0; i < list.length; i++) {
          expect(list[i].sequence).toBe(i);
        }
      }
    } finally {
      stop();
      ws.close();
    }
  }, 20_000);
});

describe("parallel fan-out — onConnect replay (same parentToolCallId)", () => {
  it("replays both helpers under one parentToolCallId without sequence collisions", async () => {
    const { name, assistant } = await freshAssistant();

    // Seed two completed rows sharing parentToolCallId, each with
    // their own stored chat chunks. Mirrors a Beta-pattern run that
    // completed before the client (re)connected.
    const chunkBody = JSON.stringify({
      type: "text-delta",
      id: "t-1",
      delta: "Hello"
    });
    await assistant.testSeedHelperRun({
      helperId: "helper-x",
      parentToolCallId: "tc-shared",
      helperType: "Researcher",
      query: "topic-x",
      status: "completed",
      summary: "x done",
      startedAt: 100,
      completedAt: 110,
      displayOrder: 0,
      chunks: [chunkBody]
    });
    await assistant.testSeedHelperRun({
      helperId: "helper-y",
      parentToolCallId: "tc-shared",
      helperType: "Researcher",
      query: "topic-y",
      status: "completed",
      summary: "y done",
      startedAt: 200,
      completedAt: 210,
      displayOrder: 1,
      chunks: [chunkBody]
    });

    const { ws } = await connectWS(wsPath(name));
    try {
      const frames = await collectHelperEvents(ws, {
        timeoutMs: 3000,
        // Stop once the second seeded helper's terminal `finished`
        // frame has arrived on the wire.
        terminate: (f) =>
          f.replay === true &&
          f.event.kind === "finished" &&
          f.event.helperId === "helper-y"
      });

      const replayFrames = frames.filter(
        (f) => f.parentToolCallId === "tc-shared" && f.replay === true
      );
      const byHelper = groupByHelper(replayFrames);
      expect(Object.keys(byHelper).sort()).toEqual(["helper-x", "helper-y"]);

      for (const helperId of ["helper-x", "helper-y"]) {
        const list = byHelper[helperId];
        // started + 1 chunk + finished = 3.
        expect(list).toHaveLength(3);
        expect(list.map((f) => f.event.kind)).toEqual([
          "started",
          "chunk",
          "finished"
        ]);
        // Per-helper sequences each start at 0 and run 0/1/2 — the
        // SAME sequence number 0 for each helper is what makes the
        // client-side dedup key need both `parentToolCallId` AND
        // `helperId`.
        expect(list.map((f) => f.sequence)).toEqual([0, 1, 2]);
      }

      // The `started` event carries the `order` field from the row's
      // `display_order` column. Without it the client would render
      // helpers in arrival order, which is race-determined for
      // concurrent fan-out.
      const xStarted = byHelper["helper-x"][0].event;
      const yStarted = byHelper["helper-y"][0].event;
      expect(xStarted.kind).toBe("started");
      expect(yStarted.kind).toBe("started");
      if (xStarted.kind === "started") expect(xStarted.order).toBe(0);
      if (yStarted.kind === "started") expect(yStarted.order).toBe(1);

      // Per-row replay must NOT interleave: helper-x's `finished`
      // arrives before helper-y's `started`. `onConnect` walks rows
      // in `started_at asc` and serializes each row's frames; this
      // test pins that ordering down so a future "interleave for
      // fairness" refactor wouldn't silently regress it.
      let lastXIdx = -1;
      let firstYIdx = -1;
      for (let i = 0; i < replayFrames.length; i++) {
        const id = replayFrames[i].event.helperId;
        if (id === "helper-x") lastXIdx = i;
        if (id === "helper-y" && firstYIdx < 0) firstYIdx = i;
      }
      expect(lastXIdx).toBeGreaterThanOrEqual(0);
      expect(firstYIdx).toBeGreaterThanOrEqual(0);
      expect(lastXIdx).toBeLessThan(firstYIdx);
    } finally {
      ws.close();
    }
  }, 20_000);
});
