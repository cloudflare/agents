/**
 * React hook for voice via Cloudflare Realtime SFU (WebRTC transport).
 *
 * Architecture:
 *   Mic → WebRTC → SFU → WebSocket Adapter → /sfu/audio-in → VoiceAgent DO
 *   VoiceAgent DO → WebSocket (direct) → Client (transcripts + audio playback)
 *
 * Reuses VoiceClient (via useVoiceAgent) for all protocol handling, playback,
 * silence/interrupt detection, and mute support. Only the audio capture path
 * differs: SFUAudioInput sets up WebRTC and monitors local audio levels via
 * AnalyserNode, while VoiceClient handles everything else.
 */

import { useState, useRef } from "react";
import {
  useVoiceAgent,
  type VoiceAudioInput
} from "agents/experimental/voice-react";
import type {
  VoiceStatus,
  TranscriptMessage,
  PipelineMetrics
} from "agents/experimental/voice-react";

const STUN_SERVER = "stun:stun.cloudflare.com:3478";

interface UseSFUVoiceOptions {
  agent: string;
  name?: string;
}

interface UseSFUVoiceReturn {
  status: VoiceStatus;
  transcript: TranscriptMessage[];
  interimTranscript: string | null;
  metrics: PipelineMetrics | null;
  audioLevel: number;
  isMuted: boolean;
  connected: boolean;
  error: string | null;
  webrtcState: string;
  startCall: () => Promise<void>;
  endCall: () => void;
  toggleMute: () => void;
  sendText: (text: string) => void;
  send: (data: Record<string, unknown>) => void;
  lastCustomMessage: unknown;
}

/**
 * Audio input that captures mic audio via WebRTC/SFU and also captures
 * locally for direct forwarding to the VoiceAgent via VoiceClient's
 * WebSocket (onAudioData). Local capture ensures audio reaches the agent
 * even when the SFU adapter can't connect back (e.g. local dev).
 * Audio levels are derived from local capture for silence/interrupt detection.
 */
class SFUAudioInput implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData: ((pcm: ArrayBuffer) => void) | null = null;

  #pc: RTCPeerConnection | null = null;
  #stream: MediaStream | null = null;
  #audioCtx: AudioContext | null = null;
  #scriptNode: ScriptProcessorNode | null = null;
  #onWebRTCState: (state: string) => void;

  constructor(onWebRTCState: (state: string) => void) {
    this.#onWebRTCState = onWebRTCState;
  }

  async start(): Promise<void> {
    // 1. Get user media
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: 16000 },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this.#stream = stream;

    // 2. Create SFU session
    const sessionResp = await fetch("/sfu/session", { method: "POST" });
    const sessionData = (await sessionResp.json()) as {
      sessionId: string;
    };
    console.log("[SFU] Session created:", sessionData.sessionId);

    // 3. Create peer connection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: STUN_SERVER }],
      bundlePolicy: "max-bundle"
    });
    this.#pc = pc;

    pc.oniceconnectionstatechange = () => {
      this.#onWebRTCState(pc.iceConnectionState);
      console.log("[SFU] ICE state:", pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log("[SFU] Connection state:", pc.connectionState);
    };

    // 4. Add mic track
    const audioTrack = stream.getAudioTracks()[0];
    pc.addTransceiver(audioTrack, { direction: "sendonly" });

    // 5. Create and set local offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 6. Send offer to SFU, get answer
    const tracksResp = await fetch("/sfu/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionData.sessionId,
        tracks: {
          sessionDescription: {
            type: "offer",
            sdp: offer.sdp
          },
          tracks: [
            {
              location: "local",
              trackName: "mic-audio",
              mid: pc.getTransceivers()[0].mid
            }
          ]
        }
      })
    });
    const tracksData = (await tracksResp.json()) as {
      sessionDescription?: { sdp: string };
    };

    if (tracksData.sessionDescription) {
      await pc.setRemoteDescription({
        type: "answer",
        sdp: tracksData.sessionDescription.sdp
      });
    }

    // 7. Capture local audio for level monitoring + direct PCM forwarding.
    // This sends audio through VoiceClient's WebSocket, ensuring it works
    // in both local dev (where the SFU can't connect back to localhost)
    // and production.
    this.#audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = this.#audioCtx.createMediaStreamSource(stream);

    // ScriptProcessorNode captures raw PCM samples for forwarding.
    // Buffer size 4096 @ 16kHz = 256ms per frame.
    const scriptNode = this.#audioCtx.createScriptProcessor(4096, 1, 1);
    this.#scriptNode = scriptNode;

    scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
      const samples = e.inputBuffer.getChannelData(0);

      // Compute RMS for audio level monitoring
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);
      this.onAudioLevel?.(rms);

      // Convert Float32 → Int16 PCM and forward to VoiceClient
      if (this.onAudioData) {
        const pcm = new ArrayBuffer(samples.length * 2);
        const view = new DataView(pcm);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]));
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        this.onAudioData(pcm);
      }
    };

    source.connect(scriptNode);
    scriptNode.connect(this.#audioCtx.destination);

    console.log("[SFU] Call started via WebRTC + local audio capture");
  }

  stop(): void {
    this.#scriptNode?.disconnect();
    this.#scriptNode = null;
    this.#pc?.close();
    this.#pc = null;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#audioCtx?.close().catch(() => {});
    this.#audioCtx = null;
    this.#onWebRTCState("closed");
  }
}

export function useSFUVoice(options: UseSFUVoiceOptions): UseSFUVoiceReturn {
  const [webrtcState, setWebrtcState] = useState("new");

  // Stable SFUAudioInput instance — persists across renders.
  // VoiceClient calls start()/stop() on call lifecycle.
  const audioInputRef = useRef<SFUAudioInput | null>(null);
  if (!audioInputRef.current) {
    audioInputRef.current = new SFUAudioInput(setWebrtcState);
  }

  const voice = useVoiceAgent({
    agent: options.agent,
    name: options.name,
    audioInput: audioInputRef.current
  });

  return { ...voice, webrtcState };
}
