/**
 * Client-side `cf_agent_* <-> AG-UI` bridge — Approach A (rfc-chat-recovery-
 * foundation, Phase 5 second harness).
 *
 * THE CORE FINDING THIS FILE EMBODIES: the shared `ResumeHandshake` driver is
 * wire-coupled. It emits `cf_agent_stream_resuming` / `cf_agent_stream_resume_none`
 * and AI-SDK-shaped `cf_agent_use_chat_response` frames (`{ body, done, id, type,
 * replay? }`); only `responseMessageType` is injectable. A `@tanstack/ai`
 * `SubscribeConnectionAdapter` instead expects a stream of AG-UI `StreamChunk`s.
 * So driving the REAL TanStack client over the REAL handshake takes a thin client
 * translation layer — and NO change to the published `agents` package. This
 * bridge IS that layer, and the fact it is small (one frame-router) is the
 * measurement: the handshake PROTOCOL (notify → ACK → replay; #1733 double-send;
 * #1645 terminal-via-resume) is transport-agnostic; only the frame VOCABULARY is
 * coupled. Whether to fold the vocabulary behind an injectable seam (Approach B)
 * is decided from how thick this bridge turned out to be.
 *
 * The same bridge backs both the React `useChat` demo (`ws-adapter.ts`) and the
 * headless Node e2e client, so the e2e exercises the real foreign-client
 * handshake rather than a hand-rolled frame sequence.
 *
 * @internal Validation fixture, not a published package.
 */

import {
  EventType,
  type ModelMessage,
  type StreamChunk
} from "@tanstack/ai/client";
import type {
  RunAgentInputContext,
  SubscribeConnectionAdapter,
  UIMessage
} from "@tanstack/ai-client";

// Wire strings mirror `CHAT_MESSAGE_TYPES` from `agents/chat` (kept local so the
// client bundle does not import the server-side `agents/chat` barrel).
const STREAM_RESUMING = "cf_agent_stream_resuming";
const STREAM_RESUME_ACK = "cf_agent_stream_resume_ack";
const STREAM_RESUME_REQUEST = "cf_agent_stream_resume_request";
const STREAM_RESUME_NONE = "cf_agent_stream_resume_none";
const USE_CHAT_RESPONSE = "cf_agent_use_chat_response";
const CHAT_RECOVERING = "cf_agent_chat_recovering";

/** A server `cf_agent_use_chat_response` frame. */
interface ResponseFrame {
  type: typeof USE_CHAT_RESPONSE;
  id: string;
  body: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
}

/** Observations the e2e asserts to prove the foreign-transport handshake fired. */
export interface BridgeObservations {
  /** `STREAM_RESUMING` frames received (the server offered a resumable stream). */
  resumingFrames: number;
  /** `STREAM_RESUME_ACK` frames this client sent in response. */
  acksSent: number;
  /** `STREAM_RESUME_NONE` frames received. */
  resumeNoneFrames: number;
  /** `CHAT_RECOVERING` status frames received. */
  recoveringFrames: number;
  /** Response frames carrying `replay: true` (the buffered partial replay). */
  replayResponseFrames: number;
  /** Total response frames carrying a non-empty AG-UI chunk body. */
  chunkFrames: number;
  /** Accumulated `TEXT_MESSAGE_CONTENT` text observed across all runs. */
  accumulatedText: string;
}

const DONE = Symbol("done");

/**
 * A `SubscribeConnectionAdapter` that speaks the agent's `cf_agent_*` resume
 * protocol over a single WebSocket and surfaces AG-UI `StreamChunk`s to the
 * TanStack client. The connection is the ONLY thing that touches the network.
 */
export class RecoveryBridgeConnection implements SubscribeConnectionAdapter {
  readonly observations: BridgeObservations = {
    resumingFrames: 0,
    acksSent: 0,
    resumeNoneFrames: 0,
    recoveringFrames: 0,
    replayResponseFrames: 0,
    chunkFrames: 0,
    accumulatedText: ""
  };

  private _ws: WebSocket | null = null;
  private _openPromise: Promise<void> | null = null;
  private _queue: StreamChunk[] = [];
  private _waiters: Array<(value: StreamChunk | typeof DONE) => void> = [];
  private _closed = false;
  private readonly _acked = new Set<string>();

  constructor(private readonly _url: string) {}

  /** Subscribe to the stream of AG-UI chunks the bridge reconstructs. */
  async *subscribe(abortSignal?: AbortSignal): AsyncIterable<StreamChunk> {
    this._ensureSocket();
    abortSignal?.addEventListener("abort", () => this._finish(), {
      once: true
    });
    while (!this._closed) {
      const next = await this._next();
      if (next === DONE) return;
      yield next;
    }
  }

  /** Push a run: send the latest user message as a `tanstack-run` frame. */
  async send(
    messages: Array<UIMessage> | Array<ModelMessage>,
    _data?: Record<string, unknown>,
    _abortSignal?: AbortSignal,
    runContext?: RunAgentInputContext
  ): Promise<void> {
    this._ensureSocket();
    await this._openPromise;
    this._ws?.send(
      JSON.stringify({
        type: "tanstack-run",
        text: lastUserText(messages),
        runId: runContext?.runId
      })
    );
  }

  /** Close the WebSocket and end the subscription. */
  close(): void {
    this._finish();
    try {
      this._ws?.close();
    } catch {
      // Already closing.
    }
    this._ws = null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private _ensureSocket(): void {
    if (this._ws) return;
    const ws = new WebSocket(this._url);
    this._ws = ws;
    this._openPromise = new Promise<void>((resolve) => {
      ws.addEventListener("open", () => {
        // Ask the server about resumable streams once our handler is attached
        // (avoids the race where a proactive onConnect notify is missed).
        ws.send(JSON.stringify({ type: STREAM_RESUME_REQUEST }));
        resolve();
      });
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      this._onFrame(typeof event.data === "string" ? event.data : "");
    });
    ws.addEventListener("close", () => this._finish());
    ws.addEventListener("error", () => this._finish());
  }

  private _onFrame(raw: string): void {
    if (!raw) return;
    let frame: { type?: string; id?: string } | null = null;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    switch (frame.type) {
      case STREAM_RESUMING: {
        this.observations.resumingFrames++;
        const id = frame.id ?? "";
        if (!this._acked.has(id)) {
          this._acked.add(id);
          this._ws?.send(JSON.stringify({ type: STREAM_RESUME_ACK, id }));
          this.observations.acksSent++;
        }
        return;
      }
      case STREAM_RESUME_NONE:
        this.observations.resumeNoneFrames++;
        return;
      case CHAT_RECOVERING:
        this.observations.recoveringFrames++;
        return;
      case USE_CHAT_RESPONSE:
        this._onResponseFrame(frame as ResponseFrame);
        return;
      default:
        // Framework frames (cf_agent_state, etc.) — ignored by the bridge.
        return;
    }
  }

  private _onResponseFrame(frame: ResponseFrame): void {
    if (frame.replay) this.observations.replayResponseFrames++;
    if (!frame.body) return; // done / replayComplete control frame — no chunk.
    let chunk: StreamChunk | null = null;
    try {
      chunk = JSON.parse(frame.body) as StreamChunk;
    } catch {
      return;
    }
    this.observations.chunkFrames++;
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      this.observations.accumulatedText += chunk.delta;
    }
    this._push(chunk);
  }

  private _push(chunk: StreamChunk): void {
    const waiter = this._waiters.shift();
    if (waiter) waiter(chunk);
    else this._queue.push(chunk);
  }

  private _next(): Promise<StreamChunk | typeof DONE> {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift() as StreamChunk);
    }
    if (this._closed) return Promise.resolve(DONE);
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  private _finish(): void {
    if (this._closed) return;
    this._closed = true;
    for (const waiter of this._waiters) waiter(DONE);
    this._waiters = [];
  }
}

/** Extract the latest user message's text from UI or model messages. */
function lastUserText(
  messages: Array<UIMessage> | Array<ModelMessage>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      content?: unknown;
      parts?: unknown;
    };
    if (message.role !== "user") continue;
    return extractText(message);
  }
  return "";
}

function extractText(message: { content?: unknown; parts?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  const blocks = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : [];
  return blocks
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : ""
    )
    .join("");
}
