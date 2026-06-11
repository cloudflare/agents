/**
 * Headless voice client — a non-browser client for `withVoice` agents.
 *
 * `VoiceClient` (./voice-client) is browser-bound: it captures the mic with
 * `getUserMedia` and plays audio through an `AudioContext`. This client has
 * no browser dependencies. It speaks the raw voice wire protocol over a
 * WebSocket you provide, so it runs anywhere there is a `WebSocket`:
 * another Worker, a Durable Object, Node, Bun, Deno, or a test runner.
 *
 * It does no audio capture or playback. You feed it raw PCM
 * (16 kHz mono 16-bit LE) and it hands back the audio frames the agent
 * sends, in whatever format was negotiated at `start_call`. Wiring those
 * to a real device, a phone leg, or a test fixture is the caller's job.
 *
 * @example
 * ```ts
 * // Worker-to-Worker: connect to an agent and stream a WAV fixture.
 * const res = await env.AGENT.fetch(
 *   new Request("https://agent/agents/my-agent/room", {
 *     headers: { Upgrade: "websocket" }
 *   })
 * );
 * const socket = res.webSocket!;
 * socket.accept();
 *
 * const client = new HeadlessVoiceClient({
 *   socket,
 *   preferredFormat: "pcm16"
 * });
 * const config = await client.startCall();   // { format: "pcm16", sampleRate: 16000 }
 * await client.streamPcm(pcm16Mono);          // feed audio
 * const reply = await client.waitForTranscript("assistant");
 * const audio = await client.nextAudio();     // agent's TTS, as `config.format`
 * client.endCall();
 * ```
 */

import {
  VOICE_PROTOCOL_VERSION,
  isVoiceAudioFormat,
  type VoiceAudioFormat,
  type VoiceRole,
  type VoiceServerMessage,
  type VoiceStatus
} from "./types";

/**
 * Minimal WebSocket surface this client relies on. Both the standard
 * `WebSocket` and the Cloudflare Workers `WebSocket` satisfy it.
 */
export interface VoiceSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void;
  addEventListener(type: "close", listener: (event: unknown) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export interface HeadlessVoiceClientOptions {
  /** An already-open (accepted) WebSocket speaking the voice protocol. */
  socket: VoiceSocket;
  /**
   * Format to request from the agent at `start_call`. The agent may honor
   * it or fall back — the negotiated result is in the `startCall()` return
   * value and `client.audioConfig`. Headless clients usually want `"pcm16"`
   * (raw, no decoder needed). If omitted, no preference is sent and the
   * agent picks its configured default.
   */
  preferredFormat?: VoiceAudioFormat;
  /** Default timeout (ms) for the `waitFor*` / `next*` helpers. @default 5000 */
  defaultTimeoutMs?: number;
}

/** Audio format negotiated for the current call. */
export interface NegotiatedAudioConfig {
  format: VoiceAudioFormat;
  sampleRate?: number;
}

/** A transcript line received from the agent. */
export interface HeadlessTranscript {
  role: VoiceRole;
  text: string;
}

/** Bytes per 100 ms of 16 kHz mono 16-bit PCM (16000 * 0.1 * 2). */
const PCM_FRAME_BYTES_100MS = 3200;

interface MessageWaiter {
  predicate: (msg: VoiceServerMessage) => boolean;
  resolve: (msg: VoiceServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AudioWaiter {
  resolve: (audio: ArrayBuffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HeadlessVoiceClient {
  /** Latest status reported by the agent. */
  status: VoiceStatus = "idle";
  /** Protocol version from the server's `welcome`, or null before it arrives. */
  protocolVersion: number | null = null;
  /** Audio format negotiated at `start_call`, or null before/without a call. */
  audioConfig: NegotiatedAudioConfig | null = null;
  /** Every JSON message received, in order — useful for assertions. */
  readonly messages: VoiceServerMessage[] = [];
  /** Every completed transcript line received, in order. */
  readonly transcripts: HeadlessTranscript[] = [];

  #socket: VoiceSocket;
  #preferredFormat: VoiceAudioFormat | undefined;
  #defaultTimeoutMs: number;

  #messageWaiters: MessageWaiter[] = [];
  #audioQueue: ArrayBuffer[] = [];
  #audioWaiters: AudioWaiter[] = [];
  #closed = false;
  // Accumulates assistant transcript deltas between start/end.
  #streamingTranscript = "";

  constructor(options: HeadlessVoiceClientOptions) {
    this.#socket = options.socket;
    this.#preferredFormat = options.preferredFormat;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;

    this.#socket.addEventListener("message", (event: MessageEvent) =>
      this.#onMessage(event.data)
    );
    this.#socket.addEventListener("close", () =>
      this.#fail(new Error("socket closed"))
    );
    this.#socket.addEventListener("error", () =>
      this.#fail(new Error("socket error"))
    );
  }

  // --- Outbound: protocol actions ---

  /**
   * Send `hello` and `start_call` and resolve once the agent replies with
   * `audio_config`. The resolved config (also stored on `audioConfig`) is
   * the format the agent actually chose, which may differ from the request.
   */
  async startCall(): Promise<NegotiatedAudioConfig> {
    this.#send({ type: "hello", protocol_version: VOICE_PROTOCOL_VERSION });
    this.#send(
      this.#preferredFormat
        ? { type: "start_call", preferred_format: this.#preferredFormat }
        : { type: "start_call" }
    );
    const msg = await this.waitForMessage((m) => m.type === "audio_config");
    return msg as NegotiatedAudioConfig & { type: "audio_config" };
  }

  /** Send one raw PCM frame (16 kHz mono 16-bit LE) as a binary message. */
  sendAudio(pcm: ArrayBuffer): void {
    this.#socket.send(pcm);
  }

  /**
   * Split a PCM buffer into frames and send them in order, mimicking a live
   * mic. By default frames are 100 ms; pass `delayMs` to pace them in real
   * time (tests usually leave it 0 and send as fast as possible).
   */
  async streamPcm(
    pcm: ArrayBuffer,
    options?: { frameBytes?: number; delayMs?: number }
  ): Promise<void> {
    const frameBytes = options?.frameBytes ?? PCM_FRAME_BYTES_100MS;
    const delayMs = options?.delayMs ?? 0;
    for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
      if (this.#closed) break;
      this.sendAudio(pcm.slice(offset, offset + frameBytes));
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /** Send a text turn (the agent treats it like a spoken utterance). */
  sendText(text: string): void {
    this.#send({ type: "text_message", text });
  }

  /** Tell the agent the user started/stopped speaking (optional VAD hints). */
  startOfSpeech(): void {
    this.#send({ type: "start_of_speech" });
  }
  endOfSpeech(): void {
    this.#send({ type: "end_of_speech" });
  }

  /** Interrupt (barge-in) the agent's current response. */
  interrupt(): void {
    this.#send({ type: "interrupt" });
  }

  /** End the call. Leaves the socket open for a later `start_call`. */
  endCall(): void {
    this.#send({ type: "end_call" });
  }

  /** Close the underlying socket and reject any pending waiters. */
  close(): void {
    this.#fail(new Error("client closed"));
    if (!this.#closed) {
      this.#closed = true;
      this.#socket.close();
    }
  }

  // --- Inbound: awaitable helpers ---

  /**
   * Resolve with the first received message matching `predicate`. Only
   * matches messages received after this call (consistent with the
   * event-driven server) — check the synchronous state fields
   * (`status`, `audioConfig`, `protocolVersion`) for already-arrived state.
   */
  waitForMessage(
    predicate: (msg: VoiceServerMessage) => boolean,
    timeoutMs = this.#defaultTimeoutMs
  ): Promise<VoiceServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#messageWaiters = this.#messageWaiters.filter((w) => w !== waiter);
        reject(new Error("timed out waiting for message"));
      }, timeoutMs);
      const waiter: MessageWaiter = { predicate, resolve, reject, timer };
      this.#messageWaiters.push(waiter);
    });
  }

  /** Resolve when the agent reports the given status (or now, if already there). */
  waitForStatus(
    status: VoiceStatus,
    timeoutMs = this.#defaultTimeoutMs
  ): Promise<void> {
    if (this.status === status) return Promise.resolve();
    return this.waitForMessage(
      (m) => m.type === "status" && m.status === status,
      timeoutMs
    ).then(() => undefined);
  }

  /**
   * Resolve with the next completed transcript line, optionally filtered by
   * role. Matches a final `transcript` or a streamed `transcript_end`.
   */
  waitForTranscript(
    role?: VoiceRole,
    timeoutMs = this.#defaultTimeoutMs
  ): Promise<string> {
    return this.waitForMessage((m) => {
      if (m.type === "transcript") return !role || m.role === role;
      // transcript_end has no role; accept it when no role filter is set
      // or the active stream was for the requested role.
      return m.type === "transcript_end" && (!role || role === "assistant");
    }, timeoutMs).then((m) =>
      m.type === "transcript" || m.type === "transcript_end" ? m.text : ""
    );
  }

  /** Resolve with the next binary audio frame from the agent. */
  nextAudio(timeoutMs = this.#defaultTimeoutMs): Promise<ArrayBuffer> {
    const queued = this.#audioQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#audioWaiters = this.#audioWaiters.filter((w) => w !== waiter);
        reject(new Error("timed out waiting for audio"));
      }, timeoutMs);
      const waiter: AudioWaiter = { resolve, reject, timer };
      this.#audioWaiters.push(waiter);
    });
  }

  /** Total audio frames received so far (already-queued, not yet consumed). */
  get pendingAudioCount(): number {
    return this.#audioQueue.length;
  }

  // --- Internals ---

  #send(msg: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(msg));
  }

  #onMessage(data: string | ArrayBuffer | Blob): void {
    if (typeof data !== "string") {
      // Binary = an audio frame. (Blob shouldn't occur on Workers/Node WS,
      // but guard anyway by ignoring non-ArrayBuffer binary.)
      if (data instanceof ArrayBuffer) this.#deliverAudio(data);
      return;
    }

    let msg: VoiceServerMessage;
    try {
      msg = JSON.parse(data) as VoiceServerMessage;
    } catch {
      return;
    }

    this.messages.push(msg);
    this.#updateState(msg);

    // Resolve the first waiter whose predicate matches.
    const idx = this.#messageWaiters.findIndex((w) => w.predicate(msg));
    if (idx !== -1) {
      const [waiter] = this.#messageWaiters.splice(idx, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  #updateState(msg: VoiceServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.protocolVersion = msg.protocol_version;
        break;
      case "status":
        this.status = msg.status;
        break;
      case "audio_config":
        this.audioConfig = {
          format: isVoiceAudioFormat(msg.format) ? msg.format : "mp3",
          sampleRate: msg.sampleRate
        };
        break;
      case "transcript":
        this.transcripts.push({ role: msg.role, text: msg.text });
        break;
      case "transcript_start":
        this.#streamingTranscript = "";
        break;
      case "transcript_delta":
        this.#streamingTranscript += msg.text;
        break;
      case "transcript_end":
        this.transcripts.push({
          role: "assistant",
          text: msg.text || this.#streamingTranscript
        });
        this.#streamingTranscript = "";
        break;
    }
  }

  #deliverAudio(audio: ArrayBuffer): void {
    const waiter = this.#audioWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(audio);
    } else {
      this.#audioQueue.push(audio);
    }
  }

  #fail(err: Error): void {
    for (const w of this.#messageWaiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    for (const w of this.#audioWaiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.#messageWaiters = [];
    this.#audioWaiters = [];
  }
}
