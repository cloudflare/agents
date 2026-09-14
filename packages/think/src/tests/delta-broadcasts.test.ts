import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type {
  ThinkTestAgent,
  ThinkToolsTestAgent
} from "./agents/think-session";

// Think's transcript broadcast policy at turn boundaries.
//
// A turn persists twice (the incoming user message, then the assistant at
// cutover) and used to push the WHOLE transcript to every socket both times.
// Now an observer that already holds a snapshot gets `cf_agent_chat_messages_
// delta` frames carrying only the rows that changed; the full
// `cf_agent_chat_messages` snapshot is reserved for connect/resume and for
// paths where the client's base can't be trusted. The bench below pins the
// bytes a turn costs against the snapshot it replaces — it fails on the
// snapshot-per-boundary behaviour.

const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_MESSAGES_DELTA = "cf_agent_chat_messages_delta";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_STREAM_RESUMING = "cf_agent_stream_resuming";
const MSG_CLIENT_CAPABILITIES = "cf_agent_chat_client_capabilities";

type Frame = Record<string, unknown> & { __bytes: number };

async function freshAgent(name: string) {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

async function connectWS(
  room: string,
  options: { declareDeltas?: boolean; agent?: string } = {}
): Promise<WebSocket> {
  const res = await exports.default.fetch(
    `http://example.com/agents/${options.agent ?? "think-test-agent"}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  if (options.declareDeltas !== false) declareDeltaSupport(ws);
  return ws;
}

/** What `useAgentChat` sends on every socket open. */
function declareDeltaSupport(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: MSG_CLIENT_CAPABILITIES,
      capabilities: { transcriptDeltas: true }
    })
  );
}

/** Record every JSON frame the server sends on `ws`, with its wire size. */
function recordFrames(ws: WebSocket): Frame[] {
  const frames: Frame[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as string;
    try {
      frames.push({
        ...(JSON.parse(data) as Record<string, unknown>),
        __bytes: data.length
      });
    } catch {
      // ignore non-JSON frames
    }
  });
  return frames;
}

/** Resolve once `frames` holds a frame matching `predicate` (or time out). */
function waitForFrame(
  frames: Frame[],
  predicate: (frame: Frame) => boolean,
  options: { from?: number; timeout?: number } = {}
): Promise<Frame> {
  const { from = 0, timeout = 5000 } = options;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const hit = frames.slice(from).find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeout) {
        return reject(
          new Error(
            `frame never arrived; saw ${JSON.stringify(frames.map((f) => f.type))}`
          )
        );
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function settle(ms = 300) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener("close", () => (clearTimeout(timer), resolve()), {
      once: true
    });
    ws.close();
  });
}

const isTranscriptFrame = (f: Frame) =>
  f.type === MSG_CHAT_MESSAGES || f.type === MSG_CHAT_MESSAGES_DELTA;
const carriesAssistant = (f: Frame) =>
  isTranscriptFrame(f) &&
  (f.messages as UIMessage[]).some((m) => m.role === "assistant");

/** A transcript large enough that a snapshot dwarfs a turn's own rows. */
function seedMessages(count: number, bytesEach: number): UIMessage[] {
  const filler = "x".repeat(bytesEach);
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `${i} ${filler}` }]
  }));
}

describe("Think — transcript deltas at turn boundaries", () => {
  it("bench: a turn costs an aligned observer two deltas, not two snapshots", async () => {
    const room = `delta-bench-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(40, 2048));

    const ws = await connectWS(room);
    const frames = recordFrames(ws);
    try {
      const snapshot = await waitForFrame(
        frames,
        (f) => f.type === MSG_CHAT_MESSAGES
      );
      expect(typeof snapshot.epoch).toBe("string");
      expect((snapshot.messages as UIMessage[]).length).toBe(40);
      const snapshotBytes = snapshot.__bytes;
      const before = frames.length;

      await agent.testChat("Hello from RPC");
      await waitForFrame(frames, (f) => carriesAssistant(f));
      await settle();

      const turnFrames = frames.slice(before).filter(isTranscriptFrame);
      const turnBytes = turnFrames.reduce((n, f) => n + f.__bytes, 0);

      // Before: 2 × MSG_CHAT_MESSAGES, each ≥ snapshotBytes (~86 KiB here).
      // After: 2 × MSG_CHAT_MESSAGES_DELTA carrying one row each.
      expect(turnFrames.map((f) => f.type)).toEqual([
        MSG_CHAT_MESSAGES_DELTA,
        MSG_CHAT_MESSAGES_DELTA
      ]);
      for (const frame of turnFrames) {
        expect(frame.epoch).toBe(snapshot.epoch);
        expect((frame.messages as UIMessage[]).length).toBe(1);
      }
      expect(turnBytes).toBeLessThan(snapshotBytes / 20);
      // Regression guard on the bound itself: a snapshot-per-boundary turn
      // would cost at least two snapshots.
      expect(turnBytes).toBeLessThan(2 * snapshotBytes);

      // Steady state stays on deltas across turns.
      const second = frames.length;
      await agent.testChat("Again");
      await waitForFrame(frames, carriesAssistant, { from: second });
      await settle();
      expect(
        frames
          .slice(second)
          .filter(isTranscriptFrame)
          .map((f) => f.type)
      ).toEqual([MSG_CHAT_MESSAGES_DELTA, MSG_CHAT_MESSAGES_DELTA]);
    } finally {
      await closeWS(ws);
    }
  });

  it("falls back to a snapshot after the transcript is re-derived (clear)", async () => {
    const room = `delta-clear-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(4, 64));

    const ws = await connectWS(room);
    const frames = recordFrames(ws);
    try {
      const snapshot = await waitForFrame(
        frames,
        (f) => f.type === MSG_CHAT_MESSAGES
      );

      await agent.clearMessages();
      await waitForFrame(frames, (f) => f.type === MSG_CHAT_CLEAR);
      const before = frames.length;

      // The clear replaced the live cache (new epoch); the client's base is
      // gone, so the first boundary after it must be a snapshot with the
      // new epoch. Once that re-aligns the observer, deltas resume.
      await agent.testChat("After clear");
      await waitForFrame(frames, carriesAssistant, { from: before });
      await settle();
      const turnFrames = frames.slice(before).filter(isTranscriptFrame);
      expect(turnFrames[0].type).toBe(MSG_CHAT_MESSAGES);
      expect(turnFrames[0].epoch).not.toBe(snapshot.epoch);
      expect(turnFrames.slice(1).map((f) => f.type)).toEqual([
        MSG_CHAT_MESSAGES_DELTA
      ]);
      expect(turnFrames[1].epoch).toBe(turnFrames[0].epoch);
    } finally {
      await closeWS(ws);
    }
  });

  it("sends a snapshot to a client that connected mid-stream, deltas to aligned ones", async () => {
    const room = `delta-midstream-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(2, 64));

    const aligned = await connectWS(room);
    const alignedFrames = recordFrames(aligned);
    let late: WebSocket | undefined;
    try {
      await waitForFrame(alignedFrames, (f) => f.type === MSG_CHAT_MESSAGES);
      const alignedBefore = alignedFrames.length;

      // Slow stream so a second client can connect while it is in flight.
      const turn = agent.testChatWithSlowStream(150, 10_000);
      await waitForFrame(
        alignedFrames,
        (f) => f.type === MSG_CHAT_MESSAGES_DELTA
      );
      late = await connectWS(room);
      const lateFrames = recordFrames(late);
      await waitForFrame(lateFrames, (f) => f.type === MSG_STREAM_RESUMING);
      // The late client is offered a resume, never a snapshot, on connect.
      expect(lateFrames.some(isTranscriptFrame)).toBe(false);

      await turn;
      await waitForFrame(lateFrames, carriesAssistant);
      await waitForFrame(alignedFrames, carriesAssistant, {
        from: alignedBefore
      });
      await settle();

      // A connection with no base forces the cutover broadcast to be a
      // snapshot — for everyone, since it is one broadcast.
      const lateTranscript = lateFrames.filter(isTranscriptFrame);
      expect(lateTranscript.map((f) => f.type)).toEqual([MSG_CHAT_MESSAGES]);
      expect((lateTranscript[0].messages as UIMessage[]).length).toBe(4);
      expect(
        alignedFrames
          .slice(alignedBefore)
          .filter(isTranscriptFrame)
          .map((f) => f.type)
      ).toEqual([MSG_CHAT_MESSAGES_DELTA, MSG_CHAT_MESSAGES]);

      // Now both are aligned: the next turn is deltas again on both.
      const a2 = alignedFrames.length;
      const l2 = lateFrames.length;
      await agent.testChat("Both aligned");
      await waitForFrame(lateFrames, carriesAssistant, { from: l2 });
      await settle();
      for (const tail of [alignedFrames.slice(a2), lateFrames.slice(l2)]) {
        expect(tail.filter(isTranscriptFrame).map((f) => f.type)).toEqual([
          MSG_CHAT_MESSAGES_DELTA,
          MSG_CHAT_MESSAGES_DELTA
        ]);
      }
    } finally {
      if (late) await closeWS(late);
      await closeWS(aligned);
    }
  });
});

describe("Think — delta capability negotiation", () => {
  it("keeps sending snapshots to a client that never declared delta support", async () => {
    // An older `agents` client has no `cf_agent_chat_messages_delta` case in
    // its frame switch and silently drops the frame — which IS the turn's
    // transcript update, so it would freeze until it reconnected. The server
    // must not send it one.
    const room = `delta-old-client-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(4, 64));

    const old = await connectWS(room, { declareDeltas: false });
    const oldFrames = recordFrames(old);
    try {
      await waitForFrame(oldFrames, (f) => f.type === MSG_CHAT_MESSAGES);
      const before = oldFrames.length;

      await agent.testChat("Hello");
      await waitForFrame(oldFrames, carriesAssistant, { from: before });
      await settle();

      const turnFrames = oldFrames.slice(before).filter(isTranscriptFrame);
      expect(turnFrames.map((f) => f.type)).toEqual([
        MSG_CHAT_MESSAGES,
        MSG_CHAT_MESSAGES
      ]);
      // The whole transcript, every time — the pre-delta behaviour.
      expect((turnFrames[1].messages as UIMessage[]).length).toBe(6);
    } finally {
      await closeWS(old);
    }
  });

  it("holds every connection to snapshots while one has not declared support", async () => {
    // A broadcast is one frame for all sockets: a single undeclared client
    // pins everyone to snapshots rather than leaving it stale.
    const room = `delta-mixed-clients-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(4, 64));

    const modern = await connectWS(room);
    const modernFrames = recordFrames(modern);
    const old = await connectWS(room, { declareDeltas: false });
    try {
      await waitForFrame(modernFrames, (f) => f.type === MSG_CHAT_MESSAGES);
      await settle();
      const before = modernFrames.length;

      await agent.testChat("Hello");
      await waitForFrame(modernFrames, carriesAssistant, { from: before });
      await settle();
      expect(
        modernFrames
          .slice(before)
          .filter(isTranscriptFrame)
          .map((f) => f.type)
      ).toEqual([MSG_CHAT_MESSAGES, MSG_CHAT_MESSAGES]);

      // Once the undeclared client is gone, deltas resume for the rest.
      await closeWS(old);
      await settle();
      const after = modernFrames.length;
      await agent.testChat("Again");
      await waitForFrame(modernFrames, carriesAssistant, { from: after });
      await settle();
      expect(
        modernFrames
          .slice(after)
          .filter(isTranscriptFrame)
          .map((f) => f.type)
      ).toEqual([MSG_CHAT_MESSAGES_DELTA, MSG_CHAT_MESSAGES_DELTA]);
    } finally {
      await closeWS(modern);
    }
  });
});

describe("Think — suppressed broadcasts still reach clients", () => {
  it("carries rows injected mid-turn by a tool on the turn's boundary frame", async () => {
    // `addMessages` from inside a tool `execute` suppresses its own broadcast
    // and rides the turn's next one. Under deltas that frame names only the
    // rows it was given, so the injected row has to be named too — otherwise
    // it is durable, in the server cache, and invisible to every client.
    const room = `delta-mid-turn-${crypto.randomUUID()}`;
    const agent = await getAgentByName(
      env.ThinkToolsTestAgent as unknown as DurableObjectNamespace<ThinkToolsTestAgent>,
      room
    );
    await agent.setEchoExecuteMode("add-messages");

    const ws = await connectWS(room, { agent: "think-tools-test-agent" });
    const frames = recordFrames(ws);
    try {
      await waitForFrame(frames, (f) => f.type === MSG_CHAT_MESSAGES);
      const before = frames.length;

      await agent.testChat("call echo");
      await waitForFrame(frames, carriesAssistant, { from: before });
      await settle();

      const probe = await agent.getMidTurnAddProbe();
      expect(probe.insideLoop).toBe(true);
      expect(probe.persisted).toBe(true);

      const delivered = frames
        .slice(before)
        .filter(isTranscriptFrame)
        .flatMap((f) => f.messages as UIMessage[])
        .map((m) => m.id);
      expect(delivered).toContain("mid-turn-injected");
    } finally {
      await closeWS(ws);
    }
  });

  it("carries `broadcast: false` rows on the next boundary frame", async () => {
    const room = `delta-no-broadcast-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(2, 64));

    const ws = await connectWS(room);
    const frames = recordFrames(ws);
    try {
      await waitForFrame(frames, (f) => f.type === MSG_CHAT_MESSAGES);
      const before = frames.length;

      await agent.addMessages(
        [
          {
            id: "silent-row",
            role: "user",
            parts: [{ type: "text", text: "quiet" }]
          }
        ],
        { broadcast: false }
      );
      await settle();
      // Suppressed means suppressed: nothing on the wire yet.
      expect(frames.slice(before).filter(isTranscriptFrame)).toEqual([]);

      await agent.testChat("Now speak");
      await waitForFrame(frames, carriesAssistant, { from: before });
      await settle();

      const delivered = frames
        .slice(before)
        .filter(isTranscriptFrame)
        .flatMap((f) => f.messages as UIMessage[])
        .map((m) => m.id);
      expect(delivered).toContain("silent-row");
    } finally {
      await closeWS(ws);
    }
  });

  it("still owes deferred rows to a connection the broadcast excluded", async () => {
    // The incoming-persist broadcast excludes the connection that posted the
    // turn. That frame must not settle rows the excluded connection has never
    // been sent — they stay owed until a frame reaches it.
    const room = `delta-excluded-${crypto.randomUUID()}`;
    const agent = await freshAgent(room);
    await agent.addMessages(seedMessages(2, 64));

    const poster = await connectWS(room);
    const posterFrames = recordFrames(poster);
    try {
      await waitForFrame(posterFrames, (f) => f.type === MSG_CHAT_MESSAGES);
      await agent.addMessages(
        [
          {
            id: "owed-row",
            role: "user",
            parts: [{ type: "text", text: "owed" }]
          }
        ],
        { broadcast: false }
      );
      const before = posterFrames.length;

      // Posted over the socket, so the incoming-persist frame excludes it.
      poster.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "posted",
                  role: "user",
                  parts: [{ type: "text", text: "hello" }]
                }
              ]
            })
          }
        })
      );
      await waitForFrame(posterFrames, carriesAssistant, { from: before });
      await settle();

      const delivered = posterFrames
        .slice(before)
        .filter(isTranscriptFrame)
        .flatMap((f) => f.messages as UIMessage[])
        .map((m) => m.id);
      expect(delivered).toContain("owed-row");
    } finally {
      await closeWS(poster);
    }
  });
});

describe("Think — transcript identity", () => {
  it("keeps an over-budget (windowed) transcript on deltas", async () => {
    // A windowed cache re-reads storage at every incoming turn. Bumping the
    // epoch on that re-read would force a snapshot on exactly the largest
    // transcripts deltas are meant to help — so the epoch only moves when the
    // rows a client holds actually changed.
    const room = `seeded-windowed-${crypto.randomUUID()}`;
    const ws = await connectWS(room, {
      agent: "think-windowed-hydration-agent"
    });
    const frames = recordFrames(ws);
    try {
      const snapshot = await waitForFrame(
        frames,
        (f) => f.type === MSG_CHAT_MESSAGES
      );
      // 10 × ~30 KiB stored against a 64 KiB budget: a window, not the path.
      expect((snapshot.messages as UIMessage[]).length).toBeLessThan(10);
      const before = frames.length;

      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "windowed-user",
                  role: "user",
                  parts: [{ type: "text", text: "tiny" }]
                }
              ]
            })
          }
        })
      );
      await waitForFrame(frames, carriesAssistant, { from: before });
      await settle();

      const turnFrames = frames.slice(before).filter(isTranscriptFrame);
      expect(turnFrames.map((f) => f.type)).toEqual([MSG_CHAT_MESSAGES_DELTA]);
      expect(turnFrames[0].epoch).toBe(snapshot.epoch);
    } finally {
      await closeWS(ws);
    }
  });
});
