import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

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

type Frame = Record<string, unknown> & { __bytes: number };

async function freshAgent(name: string) {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

async function connectWS(room: string): Promise<WebSocket> {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
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
