/**
 * Voice transport wrapper that intercepts server audio and routes it
 * to a TelnyxCallBridge for PSTN playback.
 *
 * Wraps any VoiceTransport from @cloudflare/voice/client, forwarding
 * all messages to VoiceClient while also feeding binary audio into the
 * phone bridge. VoiceClient still receives everything — it manages
 * status, interrupts, and transcript state normally.
 *
 * **Important:** The server-side agent should use `audioFormat: "pcm16"`
 * in VoiceAgentOptions. TelnyxCallBridge.playAudio() expects 16kHz mono
 * Int16 LE PCM, which matches pcm16. Other formats (mp3, opus, wav)
 * require decoding before the bridge can play them, and this transport
 * does not decode — it will log a warning and skip bridge routing.
 *
 * @example
 * ```typescript
 * import { WebSocketVoiceTransport, VoiceClient } from "@cloudflare/voice/client";
 * import { TelnyxPhoneTransport, createTelnyxVoiceConfig } from "@cloudflare/voice-telnyx";
 *
 * const telnyx = await createTelnyxVoiceConfig({
 *   jwtEndpoint: "/api/telnyx-token",
 *   autoAnswer: true,
 * });
 *
 * const transport = new TelnyxPhoneTransport({
 *   inner: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
 *   bridge: telnyx.bridge,
 * });
 *
 * const voiceClient = new VoiceClient({
 *   agent: "my-voice-agent",
 *   audioInput: telnyx.audioInput,
 *   transport,
 *   preferredFormat: "pcm16",
 * });
 *
 * voiceClient.connect();
 * voiceClient.addEventListener("connectionchange", async (connected) => {
 *   if (connected) await voiceClient.startCall();
 * });
 * ```
 */

import type { VoiceTransport } from "@cloudflare/voice/client";
import type { TelnyxCallBridge } from "../providers/call-bridge.js";

export interface TelnyxPhoneTransportConfig {
  /**
   * The underlying transport to wrap. Typically a `WebSocketVoiceTransport`
   * from @cloudflare/voice/client.
   */
  inner: VoiceTransport;
  /** The call bridge to route audio into. */
  bridge: TelnyxCallBridge;
  /**
   * Optional callback for every binary audio frame received from the server.
   * Called with the raw ArrayBuffer regardless of format.
   */
  onServerAudio?: (audio: ArrayBuffer) => void;
}

export class TelnyxPhoneTransport implements VoiceTransport {
  private inner: VoiceTransport;
  private bridge: TelnyxCallBridge;
  private audioFormat: string | null = null;
  private warnedFormat = false;
  private userAudioCallback?: (audio: ArrayBuffer) => void;

  // VoiceTransport callbacks — set by VoiceClient before connect()
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  constructor(config: TelnyxPhoneTransportConfig) {
    this.inner = config.inner;
    this.bridge = config.bridge;
    this.userAudioCallback = config.onServerAudio;
  }

  get connected(): boolean {
    return this.inner.connected;
  }

  sendJSON(data: Record<string, unknown>): void {
    this.inner.sendJSON(data);
  }

  sendBinary(data: ArrayBuffer): void {
    this.inner.sendBinary(data);
  }

  connect(): void {
    // Proxy inner transport callbacks through our properties so
    // VoiceClient (which set them before connect) receives events.
    this.inner.onopen = () => this.onopen?.();
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (err) => this.onerror?.(err);
    this.inner.onmessage = (data) => {
      this.intercept(data);
      // Always forward to VoiceClient — it needs all messages for
      // status management, interrupt detection, transcript, etc.
      this.onmessage?.(data);
    };
    this.inner.connect();
  }

  disconnect(): void {
    this.inner.disconnect();
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private intercept(data: string | ArrayBuffer | Blob): void {
    if (typeof data === "string") {
      this.trackAudioConfig(data);
    } else if (data instanceof ArrayBuffer) {
      this.routeAudio(data);
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => this.routeAudio(buf));
    }
  }

  /** Parse audio_config messages to know what format the server is sending. */
  private trackAudioConfig(json: string): void {
    try {
      const msg = JSON.parse(json) as { type?: string; format?: string };
      if (msg.type === "audio_config" && msg.format) {
        this.audioFormat = msg.format;
        this.warnedFormat = false;
      }
    } catch {
      /* not JSON — ignore */
    }
  }

  /** Fork audio to the bridge (pcm16 only) and optional user callback. */
  private routeAudio(audio: ArrayBuffer): void {
    this.userAudioCallback?.(audio);

    if (this.audioFormat === "pcm16" || this.audioFormat === null) {
      this.bridge.playAudio(audio);
    } else if (this.audioFormat && !this.warnedFormat) {
      this.warnedFormat = true;
      console.warn(
        `[TelnyxPhoneTransport] Server audio format is "${this.audioFormat}". ` +
          `TelnyxCallBridge expects pcm16 (16kHz mono Int16 LE). ` +
          `Set audioFormat: "pcm16" in your server-side VoiceAgentOptions.`
      );
    }
  }
}
