import { describe, it, expect } from "vitest";
import type { Connection } from "agents";
import {
  ResumeHandshake,
  type PendingChatTerminal,
  type ResumeHandshakeHost
} from "../resume-handshake";
import { ContinuationState } from "../continuation-state";
import type { ResumableStream } from "../resumable-stream";
import {
  replayDoneFrame,
  streamResumeNoneFrame,
  streamResumingFrame,
  terminalErrorFrame
} from "./resume-handshake-frames";

/**
 * Drives the REAL {@link ResumeHandshake} against a fake host and asserts the
 * control frames it emits `toEqual` the golden builders in
 * `resume-handshake-frames.ts`. This is what makes the golden fixture an actual
 * byte-identical GATE rather than a self-referential spec: the frames-builder
 * test freezes the shapes; THIS test proves the shared module reproduces them.
 *
 * It is host-agnostic on purpose — both `@cloudflare/ai-chat` and
 * `@cloudflare/think` route through this one driver, so covering every branch
 * here once is the strongest guard for think (whose native browser reconnect is
 * not exercised by an e2e). The chunk-content replay (`replayChunks` etc.) is
 * `ResumableStream`'s job and tested there; here we script those calls and only
 * assert the driver's OWN handshake frames.
 */

const RESPONSE_TYPE = "cf_agent_use_chat_response";

type SentFrame = Record<string, unknown>;

function makeConnection(id: string, sink: SentFrame[]): Connection {
  return {
    id,
    send: (message: string) => {
      sink.push(JSON.parse(message) as SentFrame);
    }
  } as unknown as Connection;
}

interface FakeStreamState {
  active: boolean;
  activeRequestId: string | null;
  activeStreamId: string | null;
  /** Orphaned stream id `replayChunks` returns ("" = not orphaned). */
  orphanedStreamId: string;
  replayCompletedReturn: boolean;
  replayErroredReturn: boolean;
  calls: { replayChunks: string[]; replayErrored: string[] };
}

function makeStream(over: Partial<FakeStreamState> = {}): {
  state: FakeStreamState;
  resumableStream: ResumableStream;
} {
  const state: FakeStreamState = {
    active: false,
    activeRequestId: null,
    activeStreamId: null,
    orphanedStreamId: "",
    replayCompletedReturn: false,
    replayErroredReturn: true,
    calls: { replayChunks: [], replayErrored: [] },
    ...over
  };
  const resumableStream = {
    hasActiveStream: () => state.active,
    get activeRequestId() {
      return state.activeRequestId;
    },
    get activeStreamId() {
      return state.activeStreamId;
    },
    replayChunks: (_c: Connection, requestId: string) => {
      state.calls.replayChunks.push(requestId);
      return state.orphanedStreamId;
    },
    replayCompletedChunksByRequestId: () => state.replayCompletedReturn,
    replayErroredChunksByRequestId: (_c: Connection, requestId: string) => {
      state.calls.replayErrored.push(requestId);
      return state.replayErroredReturn;
    }
  } as unknown as ResumableStream;
  return { state, resumableStream };
}

function makeHost(opts: {
  resumableStream: ResumableStream;
  continuation?: ContinuationState<Connection>;
  pendingTerminal?: PendingChatTerminal | null;
  pendingResumeConnections?: Set<string>;
  persistCalls?: string[];
}): ResumeHandshakeHost {
  return {
    responseMessageType: RESPONSE_TYPE,
    resumableStream: opts.resumableStream,
    continuation: opts.continuation ?? new ContinuationState<Connection>(),
    pendingResumeConnections:
      opts.pendingResumeConnections ?? new Set<string>(),
    pendingChatTerminal: async () => opts.pendingTerminal ?? null,
    persistOrphanedStream: async (id: string) => {
      opts.persistCalls?.push(id);
    }
  };
}

describe("ResumeHandshake (driver → golden frames)", () => {
  // ── notifyStreamResuming ───────────────────────────────────────────

  it("notify emits STREAM_RESUMING and parks the connection as pending", () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );

    handshake.notifyStreamResuming(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumingFrame("req-1")]);
    expect(pendingResumeConnections.has("c1")).toBe(true);
  });

  it("notify is a no-op with no active stream", () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );

    handshake.notifyStreamResuming(makeConnection("c1", frames));

    expect(frames).toEqual([]);
    expect(pendingResumeConnections.size).toBe(0);
  });

  // ── handleResumeRequest ────────────────────────────────────────────

  it("#1733: REQUEST while active re-sends the SAME STREAM_RESUMING (no dedupe)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));
    const conn = makeConnection("c1", frames);

    // Proactive notify (idle-connect) followed by the client's explicit request:
    // both must emit a byte-identical STREAM_RESUMING for the same connection.
    handshake.notifyStreamResuming(conn);
    await handshake.handleResumeRequest(conn);

    expect(frames).toEqual([
      streamResumingFrame("req-1"),
      streamResumingFrame("req-1")
    ]);
  });

  it("REQUEST while a DIFFERENT connection owns the active continuation → RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationState<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "other";
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumeNoneFrame()]);
  });

  it("REQUEST with no active stream but a matching pending continuation parks (no frame)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const continuation = new ContinuationState<Connection>();
    // Only `connectionId` is read by the driver's pending check.
    continuation.pending = {
      connectionId: null
    } as ContinuationState<Connection>["pending"];
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );
    const conn = makeConnection("c1", frames);

    await handshake.handleResumeRequest(conn);

    expect(frames).toEqual([]);
    expect(continuation.awaitingConnections.get("c1")).toBe(conn);
  });

  it("REQUEST with no active stream but a pending TERMINAL → STREAM_RESUMING for the terminal (#1645)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumingFrame("req-term")]);
  });

  it("REQUEST with nothing to resume → RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumeNoneFrame()]);
  });

  // ── handleResumeAck ────────────────────────────────────────────────

  it("ACK for the active stream replays chunks and persists an orphaned stream", async () => {
    const frames: SentFrame[] = [];
    const persistCalls: string[] = [];
    const { state, resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1",
      orphanedStreamId: "stream-9"
    });
    const pendingResumeConnections = new Set<string>(["c1"]);
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections, persistCalls })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-1");

    // The driver emits no control frame here (chunk replay is ResumableStream's
    // job); it clears the pending set and persists the orphaned partial.
    expect(frames).toEqual([]);
    expect(state.calls.replayChunks).toEqual(["req-1"]);
    expect(persistCalls).toEqual(["stream-9"]);
    expect(pendingResumeConnections.has("c1")).toBe(false);
  });

  it("ACK for the active stream that is NOT orphaned does not persist", async () => {
    const frames: SentFrame[] = [];
    const persistCalls: string[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1",
      orphanedStreamId: ""
    });
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, persistCalls })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-1");

    expect(persistCalls).toEqual([]);
  });

  it("ACK for a DIFFERENT active request id is ignored (no frame, no replay)", async () => {
    const frames: SentFrame[] = [];
    const { state, resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "stale-req");

    expect(frames).toEqual([]);
    expect(state.calls.replayChunks).toEqual([]);
  });

  it("ACK with a pending terminal replays errored content then the terminal error frame (#1575)", async () => {
    const frames: SentFrame[] = [];
    const { state, resumableStream } = makeStream({
      active: false,
      replayErroredReturn: true
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-term");

    expect(state.calls.replayErrored).toEqual(["req-term"]);
    expect(frames).toEqual([
      terminalErrorFrame("req-term", "boom", RESPONSE_TYPE)
    ]);
  });

  it("ACK with a pending terminal whose replay connection dropped skips the terminal frame", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayErroredReturn: false
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-term");

    // Connection dropped mid-replay: no terminal frame; the record is retained
    // for the next reconnect to retry.
    expect(frames).toEqual([]);
  });

  it("ACK for a pending terminal with a DIFFERENT request id falls through to replay-done", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: false
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "other-req");

    expect(frames).toEqual([replayDoneFrame("other-req", RESPONSE_TYPE)]);
  });

  it("ACK with completed chunks to replay emits no extra close frame", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: true
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-done");

    expect(frames).toEqual([]);
  });

  it("ACK with nothing left to replay emits a clean replay-done close", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: false
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-done");

    expect(frames).toEqual([replayDoneFrame("req-done", RESPONSE_TYPE)]);
  });
});
