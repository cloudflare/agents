import { describe, expect, it, vi } from "vitest";
import { planResume } from "./plan";
import {
  createResumableStream,
  ResumeExpiredError,
  type ResumeFetcher
} from "./resume";

// ── helpers ──────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A stream that emits `chunks`, then optionally throws (simulating a drop). */
function streamFrom(
  chunks: string[],
  dropAfter?: number
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (dropAfter !== undefined && i === dropAfter) {
        controller.error(new Error("simulated network drop"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    }
  });
}

async function readAll(rs: ReadableStream<Uint8Array>): Promise<string> {
  const reader = rs.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value);
  }
  return out;
}

/** Binding whose resume endpoint serves `chunks`; records every URL it sees. */
function bindingServing(chunks: string[], urls: string[] = []): ResumeFetcher {
  return {
    fetch: vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(streamFrom(chunks), { status: 200 });
    })
  } as unknown as ResumeFetcher;
}

// ── planResume (Layer-B decision) ──────────────────────────────────────────

describe("planResume", () => {
  it("re-attaches when a valid checkpoint was stashed", () => {
    const plan = planResume({ runId: "abc", eventOffset: 42 });
    expect(plan).toEqual({ action: "reattach", runId: "abc", fromEvent: 42 });
  });

  it("falls back when nothing was stashed (eviction before first chunk)", () => {
    expect(planResume(null).action).toBe("fallback");
    expect(planResume(undefined).action).toBe("fallback");
  });

  it("falls back on a malformed checkpoint", () => {
    expect(planResume({ runId: "", eventOffset: 1 }).action).toBe("fallback");
    expect(planResume({ runId: "x" }).action).toBe("fallback");
    expect(planResume({ runId: "x", eventOffset: -1 }).action).toBe("fallback");
    expect(planResume({ runId: "x", eventOffset: "nope" }).action).toBe(
      "fallback"
    );
  });

  it("falls back when the run is older than the buffer TTL (would 404)", () => {
    const plan = planResume(
      { runId: "abc", eventOffset: 5 },
      { createdAt: 0, now: 400_000, bufferTtlMs: 300_000 }
    );
    expect(plan.action).toBe("fallback");
  });

  it("re-attaches when within the TTL window", () => {
    const plan = planResume(
      { runId: "abc", eventOffset: 5 },
      { createdAt: 0, now: 200_000, bufferTtlMs: 300_000 }
    );
    expect(plan).toEqual({ action: "reattach", runId: "abc", fromEvent: 5 });
  });
});

// ── createResumableStream — cross-invocation re-attach ──────────────────────

describe("createResumableStream (re-attach)", () => {
  it("re-attaches with no initial body, resuming from fromEvent", async () => {
    const urls: string[] = [];
    const binding = bindingServing(["data: 7\n\n", "data: 8\n\n"], urls);
    const rs = createResumableStream({
      binding,
      gateway: "gw",
      runId: "r9",
      fromEvent: 6
    });
    expect(await readAll(rs)).toBe("data: 7\n\ndata: 8\n\n");
    expect(urls[0]).toContain("/run/r9/resume?from=6");
  });

  it("emits only complete events and reports progress from the base offset", async () => {
    const offsets: number[] = [];
    const binding = bindingServing(["data: a\n\ndata: b", "\n\ndata: c\n\n"]);
    const rs = createResumableStream({
      binding,
      gateway: "gw",
      runId: "r",
      fromEvent: 10,
      onProgress: (n) => offsets.push(n)
    });
    expect(await readAll(rs)).toBe("data: a\n\ndata: b\n\ndata: c\n\n");
    // base 10 + 1 complete event, then +2 more.
    expect(offsets).toEqual([11, 13]);
  });

  it("throws ResumeExpiredError on a 404", async () => {
    const binding = {
      fetch: vi.fn(async () => new Response("gone", { status: 404 }))
    } as unknown as ResumeFetcher;
    const rs = createResumableStream({
      binding,
      gateway: "gw",
      runId: "dead",
      fromEvent: 3
    });
    await expect(readAll(rs)).rejects.toBeInstanceOf(ResumeExpiredError);
  });

  it("reconnects after a mid-stream drop using the absolute event index", async () => {
    const urls: string[] = [];
    // initial body emits 2 events then drops; the reconnect serves the tail.
    const initial = streamFrom(["data: 1\n\n", "data: 2\n\n"], 2);
    const binding = bindingServing(["data: 3\n\n"], urls);
    const rs = createResumableStream({
      binding,
      gateway: "gw",
      runId: "r",
      fromEvent: 4,
      initial
    });
    expect(await readAll(rs)).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    // fromEvent(4) + 2 emitted = reconnect at absolute index 6.
    expect(urls[0]).toContain("resume?from=6");
  });
});
