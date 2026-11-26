import {
  RECENT_TERMINALS_MAX,
  recentChatTerminal,
  recordRecentChatTerminal
} from "../recent-terminals";
import { describe, it, expect } from "vitest";
import type { Connection } from "agents";
import {
  ResumeHandshake,
  type PendingChatTerminal,
  type ResumeHandshakeHost
} from "../resume-handshake";
import { EndedRequests } from "../chat-frames";
import { ContinuationSlots } from "../continuation-state";
import type { ReplyStreams } from "../reply-stream";
import { PreStreamTurns } from "../pre-stream-turns";
import { STREAM_RESUME_NONE_REASONS } from "../protocol";
import type { ChatTurnOutcome } from "../wire-types";
import {
  replayDoneFrame,
  streamPendingFrame,
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
 * `ReplyStreams`'s job and tested there; here we script those calls and only
 * assert the driver's OWN handshake frames.
 */

const RESPONSE_TYPE = "cf_agent_use_chat_response";

type SentFrame = Record<string, unknown>;

function makeConnection(id: string, sink: SentFrame[]): Connection {
  return {
    id,
    send: (message: string) => {
      const frame = JSON.parse(message) as SentFrame;
      if (frame.body === DROPPED_CHUNK) {
        throw new TypeError("WebSocket send() after close");
      }
      sink.push(frame);
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
  /** Chunk bodies the completed stream holds. */
  completedChunks?: string[];
  replayErroredReturn: boolean;
  originMessageIds?: string[];
  outcome?: ChatTurnOutcome;
  /** The latest stored stream of each request, by request id. */
  streams?: Record<string, "streaming" | "completed" | "error">;
  calls: {
    replayChunks: string[];
    replayErrored: string[];
    replayPending: string[];
    replayCompleted: string[];
  };
}

/** A chunk body the test connections refuse, as a closed socket does. */
const DROPPED_CHUNK = "dropped-chunk";

function settledRow(tag: string, state: "completed" | "errored") {
  return {
    stream_id: `${state}-${tag}`,
    state,
    tag,
    metadata: JSON.stringify({ cfChat: 1 }),
    chunk_count: 0,
    created_at: 0,
    updated_at: 0,
    closed_at: 0,
    error_message: null
  };
}

function makeStream(over: Partial<FakeStreamState> = {}): {
  state: FakeStreamState;
  resumableStream: ReplyStreams;
} {
  const state: FakeStreamState = {
    active: false,
    activeRequestId: null,
    activeStreamId: null,
    orphanedStreamId: "",
    replayCompletedReturn: false,
    replayErroredReturn: true,
    calls: {
      replayChunks: [],
      replayErrored: [],
      replayPending: [],
      replayCompleted: []
    },
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
    getOriginMessageIds: () => state.originMessageIds,
    latestStreamInfoForRequest: (requestId: string) => {
      const status = state.streams?.[requestId];
      return status
        ? { id: `s-${requestId}`, status, createdAt: 0, cutOff: false }
        : null;
    },
    getOutcome: () => state.outcome,
    replayClosedStreamChunks: (_c: Connection, requestId: string) => {
      state.calls.replayPending.push(requestId);
      return true;
    },
    // The settled replays read these rows: a completed stream with no
    // chunks when `replayCompletedReturn`, and an errored stream whose one
    // chunk cannot be sent (`DROPPED_CHUNK`) unless `replayErroredReturn`.
    streamOps: {
      flush: () => {},
      rowsByTag: (tag: string, rowState?: string) => {
        if (rowState === "completed") {
          state.calls.replayCompleted.push(tag);
          return state.replayCompletedReturn
            ? [settledRow(tag, "completed")]
            : [];
        }
        if (rowState === "errored") {
          state.calls.replayErrored.push(tag);
          return state.replayErroredReturn ? [] : [settledRow(tag, "errored")];
        }
        return [];
      },
      readChunks: (streamId: string, fromSeq: number) => {
        if (fromSeq !== 0) return [];
        if (streamId.startsWith("errored-")) {
          return [
            { seq: 0, chunk: JSON.stringify(DROPPED_CHUNK), created_at: 0 }
          ];
        }
        // Only the completed stream's own rows hold its chunks.
        if (!streamId.startsWith("completed-")) return [];
        return (state.completedChunks ?? []).map((body, seq) => ({
          seq,
          chunk: JSON.stringify(body),
          created_at: 0
        }));
      }
    }
  } as unknown as ReplyStreams;
  return { state, resumableStream };
}

function makeHost(opts: {
  resumableStream: ReplyStreams;
  continuation?: ContinuationSlots<Connection>;
  preStream?: PreStreamTurns<Connection>;
  pendingTerminal?: PendingChatTerminal | null;
  pendingResumeConnections?: Set<string>;
  persistCalls?: string[];
  presentConnectionIds?: Set<string>;
  heldTerminalRequestIds?: Set<string>;
}): ResumeHandshakeHost {
  return {
    ...(opts.heldTerminalRequestIds && {
      holdsTerminalFrames: (id: string) => opts.heldTerminalRequestIds!.has(id)
    }),
    responseMessageType: RESPONSE_TYPE,
    resumableStream: opts.resumableStream,
    continuation: opts.continuation ?? new ContinuationSlots<Connection>(),
    preStream: opts.preStream,
    pendingResumeConnections:
      opts.pendingResumeConnections ?? new Set<string>(),
    pendingChatTerminal: async () => opts.pendingTerminal ?? null,
    persistOrphanedStream: async (id: string) => {
      opts.persistCalls?.push(id);
    },
    isConnectionPresent: opts.presentConnectionIds
      ? (id: string) => opts.presentConnectionIds!.has(id)
      : undefined
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

    // Proactive notify has no probe id; the explicit response echoes its
    // correlation id while preserving the same stream request id.
    handshake.notifyStreamResuming(conn);
    await handshake.handleResumeRequest(conn, "probe-1");

    expect(frames).toEqual([
      streamResumingFrame("req-1"),
      streamResumingFrame("req-1", "probe-1")
    ]);
  });

  it("#2703: a REQUEST after the ACK does not park the connection again", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );
    const conn = makeConnection("c1", frames);

    handshake.notifyStreamResuming(conn);
    await handshake.handleResumeAck(conn, "req-1");
    expect(pendingResumeConnections.has("c1")).toBe(false);

    // The tab's own probe arrives after it already ACKed. The tab dedupes
    // the second STREAM_RESUMING and never ACKs again, so a connection
    // parked here gets no live chunks until the stream ends.
    await handshake.handleResumeRequest(conn, "probe-1");

    expect(pendingResumeConnections.has("c1")).toBe(false);
    // The probe is still answered, so the tab's resume does not time out.
    expect(frames.at(-1)).toMatchObject({ id: "req-1", probeId: "probe-1" });
  });

  it("#2703: a connection that closed and reconnects with the same id is parked again until it ACKs", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );
    const conn = makeConnection("c1", frames);

    handshake.notifyStreamResuming(conn);
    await handshake.handleResumeAck(conn, "req-1");
    // The tab drops; PartySocket reconnects with the same id.
    handshake.release("c1");
    const again = makeConnection("c1", frames);
    handshake.notifyStreamResuming(again);

    // Parked: no live chunks before its ACK, so the replay comes first.
    expect(pendingResumeConnections.has("c1")).toBe(true);
  });

  it("REQUEST while a DIFFERENT connection owns the active continuation → RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationSlots<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "other";
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );

    await handshake.handleResumeRequest(
      makeConnection("c1", frames),
      "probe-owned"
    );

    expect(frames).toEqual([
      streamResumeNoneFrame(
        STREAM_RESUME_NONE_REASONS.CONTINUATION_OWNED,
        "probe-owned"
      )
    ]);
  });

  it("REQUEST with no active stream but a matching pending continuation parks + keeps waiting (#1784)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const continuation = new ContinuationSlots<Connection>();
    // `connectionId` is read by the driver's pending check; `requestId` is
    // echoed into the keep-waiting frame.
    continuation.pending = {
      connectionId: null,
      requestId: "cont-1"
    } as ContinuationSlots<Connection>["pending"];
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );
    const conn = makeConnection("c1", frames);

    await handshake.handleResumeRequest(conn);

    // Now parks AND tells the client to keep waiting so its short resume probe
    // doesn't resolve "no stream" before the continuation stream starts.
    expect(frames).toEqual([streamPendingFrame("cont-1")]);
    expect(continuation.awaitingConnections.get("c1")).toBe(conn);
  });

  it("parks a tab on a running continuation whose stream has not started", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const continuation = new ContinuationSlots<Connection>();
    continuation.running = {
      connectionId: null,
      requestId: "cont-1"
    } as ContinuationSlots<Connection>["running"];
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );
    const conn = makeConnection("c1", frames);

    await handshake.handleResumeRequest(conn);

    expect(frames).toEqual([streamPendingFrame("cont-1")]);
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

  it("REQUEST with nothing to resume → correlated idle RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeRequest(
      makeConnection("c1", frames),
      "probe-idle"
    );

    expect(frames).toEqual([
      streamResumeNoneFrame(STREAM_RESUME_NONE_REASONS.IDLE, "probe-idle")
    ]);
  });

  it("REQUEST with no active stream but a pre-stream turn in flight parks + keeps waiting (#1784)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const preStream = new PreStreamTurns<Connection>();
    preStream.begin("req-pre");
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, preStream })
    );
    const conn = makeConnection("c1", frames);

    await handshake.handleResumeRequest(conn);

    expect(frames).toEqual([streamPendingFrame("req-pre")]);
    expect(preStream.awaitingConnections.get("c1")).toBe(conn);
  });

  it("REQUEST with an idle pre-stream tracker → RESUME_NONE (nothing in flight)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const preStream = new PreStreamTurns<Connection>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, preStream })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumeNoneFrame()]);
    expect(preStream.awaitingConnections.size).toBe(0);
  });

  it("active continuation owned by an ABSENT connection can be resumed by a new one (#1784)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationSlots<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "old-owner";
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        continuation,
        // "old-owner" is NOT present → the new connection may take over.
        presentConnectionIds: new Set<string>(["c1"])
      })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumingFrame("req-1")]);
  });

  it("active continuation owned by a PRESENT connection is NOT hijacked → RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationSlots<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "old-owner";
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        continuation,
        presentConnectionIds: new Set<string>(["old-owner", "c1"])
      })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([
      streamResumeNoneFrame(STREAM_RESUME_NONE_REASONS.CONTINUATION_OWNED)
    ]);
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

    // The driver emits no control frame here (chunk replay is ReplyStreams's
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

  it("ACK with a pending terminal echoes its originating message ids (#2280)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      originMessageIds: ["stream-msg"]
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: {
          requestId: "req-term",
          body: "boom",
          messageIds: ["msg-1", "msg-2"]
        }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-term");

    expect(frames).toEqual([
      {
        ...terminalErrorFrame("req-term", "boom", RESPONSE_TYPE),
        messageIds: ["msg-1", "msg-2"]
      }
    ]);
  });

  it("ACK falls back to the stream's originating message ids (#2280)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      originMessageIds: ["msg-s"]
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-term");
    await handshake.handleResumeAck(makeConnection("c2", frames), "req-none");

    expect(frames).toEqual([
      {
        ...terminalErrorFrame("req-term", "boom", RESPONSE_TYPE),
        messageIds: ["msg-s"]
      },
      { ...replayDoneFrame("req-none", RESPONSE_TYPE), messageIds: ["msg-s"] }
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
      replayCompletedReturn: true,
      completedChunks: ["stored-chunk"]
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-done");

    // The stored chunk, the replay's own terminal frame, and nothing after.
    expect(frames).toEqual([
      expect.objectContaining({ body: "stored-chunk", replay: true, seq: 0 }),
      replayDoneFrame("req-done", RESPONSE_TYPE)
    ]);
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

  it("ACK with nothing left to replay echoes the stream's outcome", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: false,
      outcome: "aborted"
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-done");

    expect(frames).toEqual([
      { ...replayDoneFrame("req-done", RESPONSE_TYPE), outcome: "aborted" }
    ]);
  });

  it("ACK while the host holds the request's terminal frames sends no early done", async () => {
    const frames: SentFrame[] = [];
    const { state, resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: false
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        heldTerminalRequestIds: new Set(["req-persisting"])
      })
    );

    await handshake.handleResumeAck(
      makeConnection("c1", frames),
      "req-persisting"
    );

    expect(frames).toEqual([]);
    expect(state.calls.replayPending).toEqual(["req-persisting"]);
  });

  describe("a request that ended while the tab was away", () => {
    const kvStore = () => {
      const map = new Map<string, unknown>();
      return {
        get: <T>(key: string) => map.get(key) as T | undefined,
        put: <T>(key: string, value: T) => void map.set(key, value)
      };
    };

    it("announces and then replays the recorded terminal of a request the tab waits on", async () => {
      const kv = kvStore();
      // Replayed after a reset and ended superseded, with no tab connected.
      recordRecentChatTerminal(kv, {
        id: "req-old",
        done: true,
        body: "",
        outcome: "skipped",
        messageIds: ["u1"]
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream();
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });
      const conn = makeConnection("c1", frames);

      await handshake.handleResumeRequest(conn, "probe-1", ["req-old"]);
      expect(frames).toEqual([streamResumingFrame("req-old", "probe-1")]);

      await handshake.handleResumeAck(conn, "req-old");
      expect(frames[1]).toEqual({
        body: "",
        done: true,
        id: "req-old",
        type: RESPONSE_TYPE,
        replay: true,
        outcome: "skipped",
        messageIds: ["u1"]
      });
    });

    it("tells the tab how every request it waits on ended, each once", async () => {
      const kv = kvStore();
      // Two requests the tab waits on both ended while it was away.
      recordRecentChatTerminal(kv, {
        id: "req-a",
        done: true,
        body: "",
        outcome: "completed"
      });
      recordRecentChatTerminal(kv, {
        id: "req-b",
        done: true,
        body: "",
        outcome: "aborted"
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream();
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids),
        ended: new EndedRequests()
      });
      const conn = makeConnection("c1", frames);

      await handshake.handleResumeRequest(conn, "probe-1", ["req-a", "req-b"]);
      // The older one's end is sent at once; the newest is announced and
      // replayed after the ACK, as for a single request.
      expect(frames).toEqual([
        {
          body: "",
          done: true,
          id: "req-a",
          type: RESPONSE_TYPE,
          replay: true,
          outcome: "completed"
        },
        streamResumingFrame("req-b", "probe-1")
      ]);
      await handshake.handleResumeAck(conn, "req-b");
      expect(frames[2]).toMatchObject({
        id: "req-b",
        done: true,
        replay: true,
        outcome: "aborted"
      });

      // A second resume from the same tab is not told req-a's end again.
      await handshake.handleResumeRequest(conn, "probe-2", ["req-a", "req-b"]);
      expect(frames.filter((f) => f.id === "req-a" && f.done)).toHaveLength(1);
    });

    it("ends the requests it waits on before parking the tab on a continuation", async () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-a",
        done: true,
        body: "",
        outcome: "completed"
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream();
      const continuation = new ContinuationSlots<Connection>();
      continuation.pending = {
        connectionId: null,
        requestId: "cont-1"
      } as ContinuationSlots<Connection>["pending"];
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream, continuation }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids),
        ended: new EndedRequests()
      });

      await handshake.handleResumeRequest(
        makeConnection("c1", frames),
        "probe-1",
        ["req-a"]
      );
      expect(frames).toEqual([
        {
          body: "",
          done: true,
          id: "req-a",
          type: RESPONSE_TYPE,
          replay: true,
          outcome: "completed"
        },
        streamPendingFrame("cont-1", "probe-1")
      ]);
    });

    it("leaves the announced pending error to the ACK and ends the other requests at once", async () => {
      const kv = kvStore();
      // req-a ended in an error the tab missed; its last recorded frame is
      // the empty done frame that followed the error.
      recordRecentChatTerminal(kv, { id: "req-a", done: true, body: "" });
      recordRecentChatTerminal(kv, {
        id: "req-b",
        done: true,
        body: "",
        outcome: "completed"
      });
      const frames: SentFrame[] = [];
      const { state, resumableStream } = makeStream({
        replayErroredReturn: true
      });
      const handshake = new ResumeHandshake({
        ...makeHost({
          resumableStream,
          pendingTerminal: { requestId: "req-a", body: "boom" }
        }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids),
        ended: new EndedRequests()
      });

      const conn = makeConnection("c1", frames);
      await handshake.handleResumeRequest(conn, "probe-1", ["req-a", "req-b"]);
      expect(frames).toEqual([
        streamResumingFrame("req-a", "probe-1"),
        {
          body: "",
          done: true,
          id: "req-b",
          type: RESPONSE_TYPE,
          replay: true,
          outcome: "completed"
        }
      ]);

      // The ACK on the same tab replays req-a's chunks, then its error.
      await handshake.handleResumeAck(conn, "req-a");
      expect(state.calls.replayErrored).toEqual(["req-a"]);
      expect(frames[2]).toEqual(
        terminalErrorFrame("req-a", "boom", RESPONSE_TYPE)
      );
    });

    it("follows a stream that closed into recovery with the end a stop recorded since", async () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-cut",
        done: true,
        body: "",
        outcome: "aborted"
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream({
        replayCompletedReturn: true,
        outcome: "recovering"
      });
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });

      await handshake.handleResumeAck(makeConnection("c1", frames), "req-cut");
      expect(frames.at(-1)).toMatchObject({
        id: "req-cut",
        done: true,
        replay: true,
        outcome: "aborted"
      });
    });

    it("ends a request the tab waits on that a recovery took over, while the recovery streams", async () => {
      // A reset cut req-cut off; recovery recorded its end and now streams
      // under req-cont. The tab was away and still waits on req-cut.
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-cut",
        done: true,
        body: "",
        outcome: "aborted"
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream({
        active: true,
        activeRequestId: "req-cont",
        activeStreamId: "s-cont"
      });
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });

      await handshake.handleResumeRequest(
        makeConnection("c1", frames),
        "probe-1",
        ["req-cut"]
      );
      // Marked replay: the request ended while the tab was away.
      expect(frames[0]).toEqual({
        body: "",
        done: true,
        id: "req-cut",
        type: RESPONSE_TYPE,
        replay: true,
        outcome: "aborted"
      });
      // Then it resumes the continuation, as before.
      expect(frames[1]).toMatchObject({ id: "req-cont" });
    });

    it("sends only the recorded end of a cut-off stream on ACK, not its chunks", async () => {
      // The app declined the recovery with `persist: false`: the stream's
      // chunks are a reply it discarded.
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-cut",
        done: true,
        body: "",
        outcome: "aborted"
      });
      const frames: SentFrame[] = [];
      const { state, resumableStream } = makeStream({
        replayCompletedReturn: true
      });
      (
        resumableStream as unknown as {
          latestStreamInfoForRequest: (id: string) => unknown;
        }
      ).latestStreamInfoForRequest = () => ({
        id: "s-cut",
        status: "completed",
        createdAt: 0,
        cutOff: true
      });
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });

      await handshake.handleResumeAck(makeConnection("c1", frames), "req-cut");
      expect(state.calls.replayCompleted).toEqual([]);
      expect(state.calls.replayChunks).toEqual([]);
      expect(frames.at(-1)).toMatchObject({
        id: "req-cut",
        done: true,
        outcome: "aborted"
      });
    });

    it("tells a tab a request's end once across a resume, a replay and a stop", async () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-cut",
        done: true,
        body: "",
        outcome: "aborted"
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream({
        active: true,
        activeRequestId: "req-cont",
        activeStreamId: "s-cont"
      });
      const ended = new EndedRequests();
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids),
        ended
      });
      const conn = makeConnection("c1", frames);

      await handshake.handleResumeRequest(conn, "probe-1", ["req-cut"]);
      await handshake.handleResumeAck(conn, "req-cut");
      handshake.sendEnded(conn, "req-cut");
      expect(
        frames.filter((f) => f.id === "req-cut" && f.done === true)
      ).toHaveLength(1);
      expect(ended.has(conn, "req-cut")).toBe(true);
      // The same tab back on a new socket (its id kept) gets the end again.
      const again: SentFrame[] = [];
      const back = makeConnection("c1", again);
      await handshake.handleResumeRequest(back, "probe-2", ["req-cut"]);
      expect(
        again.filter((f) => f.id === "req-cut" && f.done === true)
      ).toHaveLength(1);
    });

    it("gives a tab back on a new socket a request's end through its ACK", async () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-done",
        done: true,
        body: "",
        outcome: "completed"
      });
      const { resumableStream } = makeStream();
      const ended = new EndedRequests();
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids),
        ended
      });
      const ends = (sink: SentFrame[]) =>
        sink.filter((f) => f.id === "req-done" && f.done === true);

      // The first socket is told, and an ACK on it does not repeat it.
      const first: SentFrame[] = [];
      const one = makeConnection("c1", first);
      await handshake.handleResumeRequest(one, "p1", ["req-done"]);
      await handshake.handleResumeAck(one, "req-done");
      await handshake.handleResumeAck(one, "req-done");
      expect(ends(first)).toHaveLength(1);

      // The same tab on a new socket (its id kept) is told through its ACK.
      const second: SentFrame[] = [];
      const two = makeConnection("c1", second);
      await handshake.handleResumeRequest(two, "p2", ["req-done"]);
      await handshake.handleResumeAck(two, "req-done");
      expect(ends(second)).toHaveLength(1);
    });

    it("tells a tab directly how a request it stops ended", async () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, {
        id: "req-cut",
        done: true,
        body: "",
        outcome: "aborted"
      });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream();
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });
      // A fresh tab that only knows the id stops it: told directly.
      handshake.sendEnded(makeConnection("c1", frames), "req-cut");
      expect(frames[0]).toMatchObject({
        id: "req-cut",
        done: true,
        outcome: "aborted"
      });
    });

    it("sends no end without a recorded one, for the active request, or while it is held", () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, { id: "req-live", done: true });
      recordRecentChatTerminal(kv, { id: "req-held", done: true });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream({
        active: true,
        activeRequestId: "req-live",
        // A closed stream alone (an attempt retried after compaction) is
        // no evidence that the request ended.
        streams: { "req-retried": "completed" },
        outcome: "aborted"
      });
      const handshake = new ResumeHandshake({
        ...makeHost({
          resumableStream,
          heldTerminalRequestIds: new Set(["req-held"])
        }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });
      const conn = makeConnection("c1", frames);
      expect(handshake.sendEnded(conn, "req-live")).toBe(false);
      expect(handshake.sendEnded(conn, "req-held")).toBe(false);
      expect(handshake.sendEnded(conn, "req-retried")).toBe(false);
      expect(handshake.sendEnded(conn, "req-none")).toBe(false);
      expect(frames).toEqual([]);
    });

    it("says idle for a tab that waits on nothing that ended", async () => {
      const kv = kvStore();
      recordRecentChatTerminal(kv, { id: "req-other", done: true });
      const frames: SentFrame[] = [];
      const { resumableStream } = makeStream();
      const handshake = new ResumeHandshake({
        ...makeHost({ resumableStream }),
        recentTerminal: (ids) => recentChatTerminal(kv, ids)
      });

      await handshake.handleResumeRequest(
        makeConnection("c1", frames),
        "probe-1",
        ["req-mine"]
      );
      expect(frames[0]).toMatchObject({ type: "cf_agent_stream_resume_none" });
    });

    it("keeps the newest terminals, a bounded number of them", () => {
      const kv = kvStore();
      for (let i = 0; i < RECENT_TERMINALS_MAX + 4; i++) {
        recordRecentChatTerminal(kv, { id: `req-${i}`, done: true });
      }
      recordRecentChatTerminal(kv, { id: "req-5", done: true, error: true });
      // Not a terminal frame.
      recordRecentChatTerminal(kv, { id: "req-chunk", done: false });

      expect(recentChatTerminal(kv, ["req-0"])).toBeNull();
      expect(recentChatTerminal(kv, ["req-chunk"])).toBeNull();
      expect(recentChatTerminal(kv, ["req-5"])).toMatchObject({ error: true });
      expect(kv.get<unknown[]>("cf:chat-recent-terminals")?.length).toBe(
        RECENT_TERMINALS_MAX
      );
    });
  });
});
