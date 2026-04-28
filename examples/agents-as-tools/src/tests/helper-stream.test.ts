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
import { MOCK_HELPER_RESPONSE } from "./worker";

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
