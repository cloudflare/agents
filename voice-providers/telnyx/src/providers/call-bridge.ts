import type { VoiceAudioInput } from "@cloudflare/voice/client";
import { TelnyxRTC } from "@telnyx/webrtc";
import {
  float32ToInt16,
  computeRMS,
  PCM_CAPTURE_PROCESSOR_SOURCE,
  PCM_PLAYBACK_PROCESSOR_SOURCE
} from "../audio/utils.js";

/**
 * Configuration for the TelnyxCallBridge.
 *
 * Uses JWT authentication (browser-side). The JWT is generated
 * server-side from a Telnyx API key + credential connection.
 */
export interface TelnyxCallBridgeConfig {
  /** JWT token from the Telnyx telephony credentials API. */
  loginToken: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable debug logging. @default false */
  debug?: boolean;
}

interface TelnyxCallLike {
  state?: string;
  answer?: () => void;
  hangup?: () => void;
  dtmf?: (digits: string) => void;
  remoteStream?: MediaStream | null;
  peer?: { instance?: RTCPeerConnection };
}

interface TelnyxNotificationLike {
  type?: string;
  call?: TelnyxCallLike;
}

interface TelnyxRTCWithCalls {
  newCall: (options: {
    destinationNumber: string;
    callerNumber?: string;
  }) => TelnyxCallLike;
}

interface AudioInboundRtpStats extends RTCStats {
  kind?: string;
  bytesReceived?: number;
  packetsReceived?: number;
  packetsLost?: number;
  packetsDiscarded?: number;
  totalSamplesReceived?: number;
  jitterBufferEmittedCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTelnyxNotification(value: unknown): value is TelnyxNotificationLike {
  return isRecord(value);
}

function hasNewCall(
  client: TelnyxRTC
): client is TelnyxRTC & TelnyxRTCWithCalls {
  return "newCall" in client && typeof client.newCall === "function";
}

function getPeerConnection(
  call: TelnyxCallLike
): RTCPeerConnection | undefined {
  return call.peer?.instance;
}

function getRemoteStream(call: TelnyxCallLike): MediaStream | null {
  return call.remoteStream ?? null;
}

/**
 * Bridges Telnyx phone calls into the Cloudflare voice pipeline.
 *
 * Implements `VoiceAudioInput` from @cloudflare/voice — extracts PCM
 * audio from inbound phone calls and feeds it to the AI pipeline.
 * Also provides `playAudio()` for injecting response audio back
 * into the phone call.
 *
 * Usage:
 * ```typescript
 * const bridge = new TelnyxCallBridge({ loginToken: jwt });
 * const voiceClient = new VoiceClient({
 *   agent: "my-agent",
 *   audioInput: bridge,
 * });
 * ```
 */
export class TelnyxCallBridge implements VoiceAudioInput {
  // VoiceAudioInput callbacks — set by VoiceClient before start()
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null = null;

  private readonly config: TelnyxCallBridgeConfig;
  private _connected = false;
  private _activeCall: TelnyxCallLike | null = null;
  private client: TelnyxRTC | null = null;
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureWorklet: AudioWorkletNode | null = null;
  private captureBlobUrl: string | null = null;
  private captureAudioEl: HTMLAudioElement | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackWorklet: AudioWorkletNode | null = null;
  private playbackBlobUrl: string | null = null;

  constructor(config: TelnyxCallBridgeConfig) {
    this.config = config;
  }

  /** Whether the Telnyx client is connected to the platform. */
  get connected(): boolean {
    return this._connected;
  }

  /** The currently active Telnyx call, or null. */
  get activeCall(): unknown | null {
    return this._activeCall;
  }

  /** Connect to Telnyx and start listening for calls. */
  async start(): Promise<void> {
    this.client = new TelnyxRTC({
      login_token: this.config.loginToken,
      debug: this.config.debug
    });

    return new Promise<void>((resolve, reject) => {
      this.client?.on("telnyx.ready", () => {
        this._connected = true;
        resolve();
      });

      this.client?.on("telnyx.error", (error: unknown) => {
        reject(error);
      });

      this.client?.on("telnyx.notification", (notification: unknown) => {
        this.handleNotification(notification);
      });

      this.client?.connect();
    });
  }

  /** Answer the current inbound call. */
  answer(): void {
    if (!this._activeCall) throw new Error("No active call");
    this._activeCall.answer?.();
  }

  /** End the active call. */
  hangup(): void {
    if (!this._activeCall) return;
    this._activeCall.hangup?.();
  }

  /**
   * Initiate an outbound PSTN call.
   * @param destination Phone number or SIP URI to call.
   * @param callerNumber The caller ID number to present.
   * @returns The Telnyx Call object.
   */
  dial(destination: string, callerNumber?: string): unknown {
    if (!this.client) throw new Error("Not connected — call start() first");
    if (!hasNewCall(this.client)) {
      throw new Error("Telnyx client does not expose newCall()");
    }
    const call = this.client.newCall({
      destinationNumber: destination,
      callerNumber
    });
    this._activeCall = call;
    return call;
  }

  /** Send DTMF digits on the active call. */
  sendDTMF(digits: string): void {
    if (!this._activeCall) throw new Error("No active call");
    this._activeCall.dtmf?.(digits);
  }

  /**
   * Clear any buffered audio in the playback pipeline.
   * Used during interrupt detection to stop stale audio from playing.
   */
  clearPlaybackBuffer(): void {
    this.playbackWorklet?.port.postMessage("clear");
  }

  /**
   * Inject PCM audio into the active phone call (agent → caller).
   * Accepts 16kHz mono Int16 PCM. Upsamples to 48kHz for WebRTC.
   * No-op if no active call.
   */
  playAudio(pcm: ArrayBuffer): void {
    if (!this.playbackWorklet) return;
    const int16 = new Int16Array(pcm);

    // Upsample 16kHz → 48kHz (3x) via linear interpolation
    const upsampleRatio = 3;
    const float32 = new Float32Array(int16.length * upsampleRatio);
    for (let i = 0; i < int16.length; i++) {
      const current = int16[i] / 32768;
      const next = i < int16.length - 1 ? int16[i + 1] / 32768 : current;
      const base = i * upsampleRatio;
      for (let j = 0; j < upsampleRatio; j++) {
        float32[base + j] = current + (next - current) * (j / upsampleRatio);
      }
    }

    this.playbackWorklet.port.postMessage(float32);
  }

  /** Disconnect from Telnyx and clean up all resources. */
  stop(): void {
    this.stopAudioCapture();
    this.stopAudioPlayback();
    this._activeCall = null;
    this._connected = false;
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  private handleNotification(notification: unknown): void {
    if (!isTelnyxNotification(notification)) return;

    console.log(
      "[TelnyxCallBridge] notification:",
      notification.type,
      "call:",
      !!notification.call,
      "state:",
      notification.call?.state
    );
    if (notification.type !== "callUpdate" || !notification.call) return;

    const call = notification.call;
    console.log("[TelnyxCallBridge] call state:", call.state);

    switch (call.state) {
      case "ringing":
        this._activeCall = call;
        if (this.config.autoAnswer) {
          console.log("[TelnyxCallBridge] auto-answering call");
          call.answer?.();
        }
        break;

      case "active":
        this._activeCall = call;
        console.log(
          "[TelnyxCallBridge] call active — starting audio capture + playback"
        );
        this.startAudioCapture(call).catch((err) =>
          console.error("[TelnyxCallBridge] startAudioCapture failed:", err)
        );
        this.startAudioPlayback(call).catch((err) =>
          console.error("[TelnyxCallBridge] startAudioPlayback failed:", err)
        );
        break;

      case "hangup":
      case "destroy":
      case "purge":
        this.stopAudioCapture();
        this.stopAudioPlayback();
        this._activeCall = null;
        break;
    }
  }

  private async startAudioCapture(call: TelnyxCallLike): Promise<void> {
    // Get the remote audio track from the peer connection receiver.
    const pc = getPeerConnection(call);
    let track: MediaStreamTrack | null = null;

    if (pc) {
      const receivers = pc.getReceivers();
      const audioReceiver = receivers.find(
        (r: RTCRtpReceiver) => r.track?.kind === "audio"
      );
      track = audioReceiver?.track ?? null;
    }

    // Fall back to call.remoteStream
    if (!track) {
      const stream = getRemoteStream(call);
      track = stream?.getAudioTracks()?.[0] ?? null;
    }

    if (!track || track.readyState !== "live") {
      console.warn(
        "[TelnyxCallBridge] No live audio track — audio capture skipped"
      );
      return;
    }

    // Ensure the track is enabled
    track.enabled = true;

    const remoteStream = new MediaStream([track]);

    // Attach the remote stream to an <audio> element to force the browser's
    // WebRTC audio decoder to start processing incoming RTP packets. Without
    // a media element consumer, the decoder may never run despite packets
    // arriving at the transport level (totalSamplesReceived stays 0).
    this.captureAudioEl = document.createElement("audio");
    this.captureAudioEl.srcObject = remoteStream;
    this.captureAudioEl.autoplay = true;
    this.captureAudioEl.volume = 0; // silent — audio goes to AI pipeline, not speakers
    document.body.appendChild(this.captureAudioEl);
    try {
      await this.captureAudioEl.play();
    } catch (e) {
      console.warn("[TelnyxCallBridge] audio element play() failed:", e);
    }

    // Wait for track to unmute (media won't flow until DTLS completes)
    if (track.muted) {
      console.log("[TelnyxCallBridge] track muted — waiting for unmute...");
      await new Promise<void>((resolve) => {
        const onUnmute = () => {
          track.removeEventListener("unmute", onUnmute);
          console.log("[TelnyxCallBridge] track unmuted");
          resolve();
        };
        track.addEventListener("unmute", onUnmute);
        setTimeout(() => {
          track.removeEventListener("unmute", onUnmute);
          resolve();
        }, 5000);
      });
    }

    // Start background stats monitoring to track decoder state
    if (pc) {
      this.monitorInboundStats(pc);
    }

    // Set up AudioContext for capture at 48kHz (matching WebRTC)
    this.captureContext = new AudioContext({ sampleRate: 48000 });
    if (this.captureContext.state === "suspended") {
      await this.captureContext.resume();
    }

    const blob = new Blob([PCM_CAPTURE_PROCESSOR_SOURCE], {
      type: "application/javascript"
    });
    this.captureBlobUrl = URL.createObjectURL(blob);
    await this.captureContext.audioWorklet.addModule(this.captureBlobUrl);

    this.captureSource =
      this.captureContext.createMediaStreamSource(remoteStream);
    this.captureWorklet = new AudioWorkletNode(
      this.captureContext,
      "pcm-capture-processor"
    );

    const downsampleRatio = 3; // 48kHz → 16kHz
    let captureCount = 0;
    this.captureWorklet.port.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof Float32Array)) return;
      const raw = event.data;

      // Downsample 48kHz → 16kHz via linear interpolation
      const outLen = Math.floor(raw.length / downsampleRatio);
      const float32 = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * downsampleRatio;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, raw.length - 1);
        const frac = srcIdx - idx0;
        float32[i] = raw[idx0] * (1 - frac) + raw[idx1] * frac;
      }

      const rms = computeRMS(float32);
      captureCount++;
      if (captureCount <= 5 || captureCount % 200 === 0) {
        console.log(
          `[TelnyxCallBridge] capture #${captureCount} rms=${rms.toFixed(4)} samples=${float32.length}`
        );
      }
      this.onAudioLevel?.(rms);
      const int16 = float32ToInt16(float32);
      this.onAudioData?.(int16.buffer as ArrayBuffer);
    };

    this.captureSource.connect(this.captureWorklet);
    this.captureWorklet.connect(this.captureContext.destination);
  }

  private monitorInboundStats(pc: RTCPeerConnection): void {
    let count = 0;
    this.statsInterval = setInterval(async () => {
      count++;
      if (count > 10 || pc.connectionState === "closed") {
        if (this.statsInterval) {
          clearInterval(this.statsInterval);
          this.statsInterval = null;
        }
        return;
      }
      try {
        const stats = await pc.getStats();
        for (const [, report] of stats) {
          const inbound = report as AudioInboundRtpStats;
          if (inbound.type === "inbound-rtp" && inbound.kind === "audio") {
            console.log(
              "[TelnyxCallBridge] inbound-rtp:",
              `bytesRx=${inbound.bytesReceived}`,
              `pktsRx=${inbound.packetsReceived}`,
              `pktsLost=${inbound.packetsLost}`,
              `pktsDiscard=${inbound.packetsDiscarded ?? "n/a"}`,
              `samplesRx=${inbound.totalSamplesReceived}`,
              `jbEmit=${inbound.jitterBufferEmittedCount}`
            );
          }
        }
      } catch {
        if (this.statsInterval) {
          clearInterval(this.statsInterval);
          this.statsInterval = null;
        }
      }
    }, 2000);
  }

  private stopAudioCapture(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.captureWorklet) {
      this.captureWorklet.disconnect();
      this.captureWorklet = null;
    }
    if (this.captureSource) {
      this.captureSource.disconnect();
      this.captureSource = null;
    }
    if (this.captureContext) {
      this.captureContext.close();
      this.captureContext = null;
    }
    if (this.captureBlobUrl) {
      URL.revokeObjectURL(this.captureBlobUrl);
      this.captureBlobUrl = null;
    }
    if (this.captureAudioEl) {
      this.captureAudioEl.pause();
      this.captureAudioEl.srcObject = null;
      this.captureAudioEl.remove();
      this.captureAudioEl = null;
    }
  }

  private async startAudioPlayback(call: TelnyxCallLike): Promise<void> {
    const peerConnection = getPeerConnection(call);
    if (!peerConnection) return;

    this.playbackContext = new AudioContext({ sampleRate: 48000 });
    if (this.playbackContext.state === "suspended") {
      await this.playbackContext.resume();
    }

    const blob = new Blob([PCM_PLAYBACK_PROCESSOR_SOURCE], {
      type: "application/javascript"
    });
    this.playbackBlobUrl = URL.createObjectURL(blob);
    await this.playbackContext.audioWorklet.addModule(this.playbackBlobUrl);

    this.playbackWorklet = new AudioWorkletNode(
      this.playbackContext,
      "pcm-playback-processor"
    );

    const destination = this.playbackContext.createMediaStreamDestination();
    this.playbackWorklet.connect(destination);

    const audioTrack = destination.stream.getAudioTracks()[0];
    if (audioTrack) {
      const sender = peerConnection
        .getSenders()
        .find((s: RTCRtpSender) => s.track?.kind === "audio");
      if (sender) {
        await sender.replaceTrack(audioTrack);
      }
    }
  }

  private stopAudioPlayback(): void {
    if (this.playbackWorklet) {
      this.playbackWorklet.disconnect();
      this.playbackWorklet = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    if (this.playbackBlobUrl) {
      URL.revokeObjectURL(this.playbackBlobUrl);
      this.playbackBlobUrl = null;
    }
  }
}
