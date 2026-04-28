/**
 * `Researcher.runTurnAndStream` byte-stream contract.
 *
 * The wire shape between the helper sub-agent and the parent is
 * load-bearing for the whole example:
 *
 *   - It must be a `ReadableStream<Uint8Array>` — workerd's JSRPC
 *     stream serializer rejects object chunks (see
 *     https://github.com/cloudflare/workerd/issues/6675).
 *   - Each line is NDJSON `{ "sequence": N, "body": "<chunk-json>" }`
 *     where `body` is a JSON-encoded `UIMessageChunk` from Think's
 *     `_streamResult`.
 *   - Each chunk is also durably stored in Think's own
 *     `_resumableStream` (visible via `getChatChunksForReplay`), so a
 *     parent reconnect mid-helper never leaks a chunk that's only in
 *     flight.
 *
 * These tests drive `runTurnAndStream` end-to-end through the
 * production `subAgent` resolution path (via a TestAssistant seam)
 * with the test-only mock model providing deterministic chunks. No
 * Workers AI binding is needed.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueAssistantName } from "./helpers";
import type { Assistant } from "./worker";
import { MOCK_HELPER_RESPONSE, MOCK_HELPER_THROWN_ERROR } from "./worker";

async function freshAssistant(): Promise<DurableObjectStub<Assistant>> {
  return getAgentByName(env.Assistant, uniqueAssistantName());
}

interface UIChunk {
  type: string;
  delta?: string;
  id?: string;
  [key: string]: unknown;
}

function parseChunk(body: string): UIChunk {
  return JSON.parse(body) as UIChunk;
}

describe("Researcher.runTurnAndStream — byte-stream contract", () => {
  it("emits NDJSON frames in monotonic sequence starting at 0", async () => {
    const assistant = await freshAssistant();
    const frames = await assistant.testRunHelperToCompletion(
      "h-byte",
      "What is HTTP/3?"
    );

    // Mock model emits at minimum: text-start, text-delta, text-end,
    // finish — Think wraps these in `start` / `start-step` / `finish`
    // shells, so 5+ frames is the floor.
    expect(frames.length).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].sequence).toBe(i);
      expect(typeof frames[i].body).toBe("string");
      // body must be valid JSON.
      expect(() => JSON.parse(frames[i].body)).not.toThrow();
    }
  }, 20_000);

  it("frames carry the mock model's text-delta as a UIMessageChunk", async () => {
    const assistant = await freshAssistant();
    const frames = await assistant.testRunHelperToCompletion(
      "h-text",
      "Why are HTTP semantics moving to QUIC?"
    );
    const chunks = frames.map((f) => parseChunk(f.body));

    const textDelta = chunks.find((c) => c.type === "text-delta");
    expect(textDelta).toBeTruthy();
    expect(textDelta?.delta).toBe(MOCK_HELPER_RESPONSE);
  }, 20_000);

  it("every emitted chunk is durably stored on the helper", async () => {
    const assistant = await freshAssistant();
    const live = await assistant.testRunHelperToCompletion(
      "h-stored",
      "verify storage round-trip"
    );

    const stored = await assistant.testReadStoredHelperChunks("h-stored");
    expect(stored.length).toBeGreaterThan(0);
    // The full live byte-stream is the helper's chat broadcast.
    // Stored chunks are the same bodies, indexed by `chunk_index`.
    // Live frame `body` should equal stored `body` 1:1 in order.
    // (Live frame sequence is 0-based across the live stream;
    // stored chunk_index is 0-based across the stored stream. They
    // must align since the helper writes the chunk durably and
    // tees it to the live forwarder in the same iteration of
    // `_streamResult`.)
    for (let i = 0; i < stored.length; i++) {
      expect(stored[i].chunkIndex).toBe(i);
      expect(stored[i].body).toBe(live[i].body);
    }
  }, 20_000);

  it("getFinalAssistantText returns the mock model's full text", async () => {
    const assistant = await freshAssistant();
    await assistant.testRunHelperToCompletion(
      "h-final",
      "ask the helper for a summary"
    );

    const final = await assistant.testReadHelperFinalText("h-final");
    expect(final).toContain(MOCK_HELPER_RESPONSE);
  }, 20_000);
});

describe("Researcher.getChatChunksForReplay", () => {
  it("returns an empty array for a helper that has not run a turn", async () => {
    const assistant = await freshAssistant();
    const stored = await assistant.testReadStoredHelperChunks("never-ran");
    expect(stored).toEqual([]);
  });
});

describe("Planner — end-to-end through the byte stream", () => {
  it("drives a Planner turn through the same protocol Researcher uses", async () => {
    const assistant = await freshAssistant();
    // Same `testRunHelperToCompletion` seam, just `className: "Planner"`.
    // Validates that Ring 2's helper-event vocabulary generalizes
    // across diverse helpers — the chunk firehose works the same
    // whether the helper is Researcher or Planner.
    const frames = await assistant.testRunHelperToCompletion(
      "h-plan",
      "add a dark mode toggle",
      "Planner"
    );

    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].sequence).toBe(i);
      expect(typeof frames[i].body).toBe("string");
      expect(() => JSON.parse(frames[i].body)).not.toThrow();
    }

    const chunks = frames.map((f) => parseChunk(f.body));
    const textDelta = chunks.find((c) => c.type === "text-delta");
    expect(textDelta).toBeTruthy();
    expect(textDelta?.delta).toBe(MOCK_HELPER_RESPONSE);

    const stored = await assistant.testReadStoredHelperChunks(
      "h-plan",
      "Planner"
    );
    expect(stored).toHaveLength(frames.length);
    for (let i = 0; i < frames.length; i++) {
      expect(stored[i].body).toBe(frames[i].body);
    }

    const final = await assistant.testReadHelperFinalText("h-plan", "Planner");
    expect(final).toContain(MOCK_HELPER_RESPONSE);
  }, 20_000);
});

describe("Researcher.getFinalTurnText — drill-in safety (H1)", () => {
  it("returns null on a helper that has not run a turn", async () => {
    const assistant = await freshAssistant();
    // No turn ever ran on this helper — no `_preTurnAssistantIds`
    // snapshot. `getFinalTurnText` must return null rather than walk
    // back into pre-existing assistant messages (would have been
    // empty here anyway, but the contract matters).
    const text = await assistant.testReadHelperFinalText("never-turned");
    expect(text).toBeNull();
  });

  it("returns the THIS turn's assistant text after the turn completes", async () => {
    const assistant = await freshAssistant();
    await assistant.testRunHelperToCompletion("h-final-turn", "do a thing");
    const text = await assistant.testReadHelperFinalText("h-final-turn");
    // Must match the mock's response, identifying the message
    // produced BY this turn rather than walking backwards.
    expect(text).toBe(MOCK_HELPER_RESPONSE);
  }, 20_000);
});

describe("Researcher.runTurnAndStream — error surfacing (B2)", () => {
  it("surfaces the helper's actual stream error to the parent", async () => {
    const assistant = await freshAssistant();
    // Spawn the helper and flip its mock into throwing mode BEFORE
    // we drive the turn, so `doStream` rejects synchronously inside
    // Think's `_streamResult`.
    await assistant.testSetHelperMockMode("h-throw", "throws");

    // Drive the turn — Think's `_streamResult` catches the error
    // internally and broadcasts an `error: true` chat-response
    // frame, then `saveMessages` resolves. The parent reads the
    // empty stream, calls `getFinalTurnText` (null), then falls
    // back to `getLastStreamError` which carries the actual
    // exception message from the mock.
    const frames = await assistant.testRunHelperToCompletion(
      "h-throw",
      "this turn will fail"
    );

    // The frames array may be empty (no chunks ever broadcast
    // because `doStream` failed before producing any), or may
    // contain a small number of pre-error chunks. Either way the
    // stashed error must be readable.
    expect(frames.length).toBeGreaterThanOrEqual(0);

    const lastError = await assistant.testReadHelperStreamError("h-throw");
    expect(lastError).toContain(MOCK_HELPER_THROWN_ERROR);

    // And `getFinalTurnText` returns null because no assistant
    // message was persisted from this turn.
    const finalText = await assistant.testReadHelperFinalText("h-throw");
    expect(finalText).toBeNull();
  }, 20_000);
});

// The H2 concurrent-call guard (`_runInProgress`) is verified by code
// review rather than by a test. Two paths were tried and rejected:
//
//   - Race two real `runTurnAndStream` calls — the mock model is too
//     fast; the first turn finishes and releases the claim before
//     the second call lands.
//   - Force the claim via a test seam, then call `runTurnAndStream` —
//     the sync throw on the helper side surfaces both as the awaited
//     rejection (correctly caught by the test) AND as an unhandled
//     rejection trail through the JSRPC bridge (which lights up
//     vitest's unhandled-error detector even though the parent
//     handles the error correctly). Returning a stream that errors-
//     on-read instead loses the concrete error message via workerd's
//     "Network connection lost" wrapper (cloudflare/workerd #6675).
//
// The guard itself is straightforward: a sync boolean checked at
// entry, set on success, cleared in `finally`/`cancel`. Inspectable
// in `Researcher.runTurnAndStream` directly.
