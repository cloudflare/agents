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
 * Audio input that captures mic audio via WebRTC/SFU and monitors
 * local audio levels via AnalyserNode. Audio flows through the SFU
 * to the VoiceAgent — VoiceClient only sees audio levels for
 * silence/interrupt detection.
 */
class SFUAudioInput implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;

  #pc: RTCPeerConnection | null = null;
  #stream: MediaStream | null = null;
  #monitorCtx: AudioContext | null = null;
  #animFrame: number | null = null;
  #onWebRTCState: (state: string) => void;

  constructor(onWebRTCState: (state: string) => void) {
    this.#onWebRTCState = onWebRTCState;
  }

  async start(): Promise<void> {
    // 1. Get user media
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: 48000 },
        channelCount: { ideal: 2 },
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

    // 7. Create SFU WebSocket adapter to stream user audio to /sfu/audio-in
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const audioInUrl = `${wsProtocol}//${window.location.host}/sfu/audio-in`;

    const adapterResp = await fetch("/sfu/adapter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tracks: [
          {
            location: "remote",
            sessionId: sessionData.sessionId,
            trackName: "mic-audio",
            endpoint: audioInUrl,
            outputCodec: "pcm"
          }
        ]
      })
    });
    const adapterData = await adapterResp.json();
    console.log("[SFU] Adapter created:", adapterData);

    // 8. Start monitoring local audio levels via AnalyserNode
    this.#monitorCtx = new AudioContext();
    const source = this.#monitorCtx.createMediaStreamSource(stream);
    const analyser = this.#monitorCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const dataArray = new Float32Array(analyser.fftSize);
    const monitorLoop = () => {
      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      this.onAudioLevel?.(rms);
      this.#animFrame = requestAnimationFrame(monitorLoop);
    };
    this.#animFrame = requestAnimationFrame(monitorLoop);

    console.log("[SFU] Call started via WebRTC");
  }

  stop(): void {
    if (this.#animFrame) {
      cancelAnimationFrame(this.#animFrame);
      this.#animFrame = null;
    }
    this.#pc?.close();
    this.#pc = null;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#monitorCtx?.close().catch(() => {});
    this.#monitorCtx = null;
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
