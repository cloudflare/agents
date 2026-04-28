/**
 * `Researcher.startAndStream` byte-stream contract.
 *
 * The wire shape between the helper sub-agent and the parent is
 * load-bearing for the entire example:
 *
 *   - It must be a `ReadableStream<Uint8Array>` — workerd's JSRPC
 *     stream serializer rejects object chunks ("Network connection
 *     lost"). The byte-stream pivot in v0.1 is what makes the helper
 *     reachable at all.
 *   - Each line is NDJSON `{ "sequence": N, "body": "<JSON event>" }`
 *     where `sequence` is the helper-local index and matches the
 *     `chunk_index` used for replay dedup on the client.
 *   - Each emitted event is durably stored in the helper's own
 *     `ResumableStream` BEFORE it's enqueued, so a parent reconnect
 *     mid-helper never leaks an event that's only in flight.
 *
 * These tests drive `startAndStream` through the production
 * `subAgent` resolution path (via a TestAssistant seam) and assert
 * each invariant. `synthesize` is the one real LLM call inside the
 * helper; with `env.AI` unbound in the test wrangler it throws, the
 * helper's `try`/`catch` emits a terminal `error` event, and the
 * stream closes — which is exactly the contract the error-path
 * assertion relies on.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueAssistantName } from "./helpers";
import type { HelperEvent } from "../protocol";
import type { Assistant } from "./worker";

async function freshAssistant(): Promise<DurableObjectStub<Assistant>> {
  return getAgentByName(env.Assistant, uniqueAssistantName());
}

function parseEvent(body: string): HelperEvent {
  return JSON.parse(body) as HelperEvent;
}

describe("Researcher.startAndStream — byte-stream contract", () => {
  it("emits NDJSON frames in monotonic sequence starting at 0", async () => {
    const assistant = await freshAssistant();
    const frames = await assistant.testRunHelperToCompletion(
      "h-byte",
      "What is HTTP/3?"
    );

    // Helper always emits at least: started, step("Planning…"),
    // (step + tool-call + tool-result) × N aspects, step("Synth…"),
    // error (because env.AI is unbound). 3 aspects → 11 events min.
    expect(frames.length).toBeGreaterThanOrEqual(6);

    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].sequence).toBe(i);
      expect(typeof frames[i].body).toBe("string");
    }
  }, 20_000);

  it("first event is `started` with the query and helperType", async () => {
    const assistant = await freshAssistant();
    const frames = await assistant.testRunHelperToCompletion(
      "h-started",
      "Why are HTTP semantics moving to QUIC?"
    );

    expect(frames[0].sequence).toBe(0);
    const started = parseEvent(frames[0].body);
    expect(started).toEqual({
      kind: "started",
      helperId: "h-started",
      helperType: "Researcher",
      query: "Why are HTTP semantics moving to QUIC?"
    });
  }, 20_000);

  it("last event is `error` when synthesize throws (no AI binding)", async () => {
    const assistant = await freshAssistant();
    const frames = await assistant.testRunHelperToCompletion(
      "h-error",
      "kick the AI binding"
    );
    const events = frames.map((f) => parseEvent(f.body));

    // Synthesize must be the failing call, not anything earlier in
    // the deterministic pre-LLM steps.
    const synthStep = events.find(
      (e) => e.kind === "step" && /Synthesi[sz]ing/i.test(e.description)
    );
    expect(synthStep).toBeTruthy();

    const last = events[events.length - 1];
    expect(last.kind).toBe("error");
    if (last.kind === "error") {
      expect(last.helperId).toBe("h-error");
      expect(last.error).toBeTruthy();
    }
  }, 20_000);

  it("every emitted event is durably stored on the helper", async () => {
    const assistant = await freshAssistant();
    const live = await assistant.testRunHelperToCompletion(
      "h-stored",
      "verify storage round-trip"
    );

    const stored = await assistant.testReadStoredHelperEvents("h-stored");
    expect(stored).toHaveLength(live.length);

    // Stored events round-trip exactly — body is the same JSON
    // string the parent saw on the wire, indexed by chunk_index.
    for (let i = 0; i < live.length; i++) {
      expect(stored[i].chunkIndex).toBe(live[i].sequence);
      expect(stored[i].body).toBe(live[i].body);
    }
  }, 20_000);

  it("step events follow the planning → search × N → synth ordering", async () => {
    const assistant = await freshAssistant();
    const frames = await assistant.testRunHelperToCompletion(
      "h-steps",
      "what does step ordering look like"
    );
    const events = frames.map((f) => parseEvent(f.body));

    const stepNumbers = events
      .filter((e) => e.kind === "step")
      .map((e) => (e.kind === "step" ? e.step : -1));

    expect(stepNumbers.length).toBeGreaterThanOrEqual(3);
    // Strictly increasing.
    for (let i = 1; i < stepNumbers.length; i++) {
      expect(stepNumbers[i]).toBeGreaterThan(stepNumbers[i - 1]);
    }

    // Each search step has a paired tool-call + tool-result.
    const toolCallIds = events
      .filter((e) => e.kind === "tool-call")
      .map((e) => (e.kind === "tool-call" ? e.toolCallId : ""));
    const toolResultIds = events
      .filter((e) => e.kind === "tool-result")
      .map((e) => (e.kind === "tool-result" ? e.toolCallId : ""));
    expect(toolCallIds.length).toBeGreaterThanOrEqual(1);
    expect(toolResultIds).toEqual(toolCallIds);
  }, 20_000);
});

describe("Researcher.getStoredEventsForRun", () => {
  it("returns an empty array for a run id with no stored events", async () => {
    const assistant = await freshAssistant();
    const stored = await assistant.testReadStoredHelperEvents("never-ran");
    expect(stored).toEqual([]);
  });
});
