/**
 * React hook for voice via Cloudflare Realtime SFU (WebRTC transport).
 *
 * Architecture:
 *   Mic → WebRTC → SFU → WebSocket Adapter → /sfu/audio-in → VoiceAgent DO
 *   VoiceAgent DO → WebSocket (direct) → Client (transcripts + audio playback)
 *
 * The user's mic audio goes through WebRTC (SFU handles NAT traversal,
 * jitter buffering, packet loss). Agent responses come back through a
 * direct WebSocket (same protocol as VoiceClient). Silence detection runs
 * locally on the client and sends end_of_speech through the WebSocket.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { VoiceStatus } from "agents/experimental/voice-react";
import type {
  TranscriptMessage,
  PipelineMetrics
} from "agents/experimental/voice-client";

const STUN_SERVER = "stun:stun.cloudflare.com:3478";
const SILENCE_THRESHOLD = 0.01;
const SILENCE_DURATION_MS = 500;

interface UseSFUVoiceOptions {
  agent: string;
  name?: string;
}

interface UseSFUVoiceReturn {
  status: VoiceStatus;
  transcript: TranscriptMessage[];
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
}

export function useSFUVoice(options: UseSFUVoiceOptions): UseSFUVoiceReturn {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webrtcState, setWebrtcState] = useState("new");

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpeakingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);

  // Handle JSON protocol messages (same protocol as VoiceClient)
  const handleJSONMessage = useCallback((data: string) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "status":
          setStatus(msg.status);
          if (msg.status === "listening" || msg.status === "idle") {
            setError(null);
          }
          break;
        case "transcript":
          setTranscript((prev) => [
            ...prev,
            { role: msg.role, text: msg.text, timestamp: Date.now() }
          ]);
          break;
        case "transcript_start":
          setTranscript((prev) => [
            ...prev,
            { role: "assistant", text: "", timestamp: Date.now() }
          ]);
          break;
        case "transcript_delta":
          setTranscript((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                text: last.text + msg.text
              };
            }
            return updated;
          });
          break;
        case "transcript_end":
          setTranscript((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === "assistant") {
              updated[updated.length - 1] = { ...last, text: msg.text };
            }
            return updated;
          });
          break;
        case "metrics":
          setMetrics({
            vad_ms: msg.vad_ms,
            stt_ms: msg.stt_ms,
            llm_ms: msg.llm_ms,
            tts_ms: msg.tts_ms,
            first_audio_ms: msg.first_audio_ms,
            total_ms: msg.total_ms
          });
          break;
        case "error":
          setError(msg.message);
          break;
      }
    } catch {
      // ignore
    }
  }, []);

  // Audio playback (same as VoiceClient)
  const getAudioContext = useCallback(async (): Promise<AudioContext> => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ sampleRate: 48000 });
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const playAudio = useCallback(
    async (mp3Data: ArrayBuffer) => {
      try {
        const ctx = await getAudioContext();
        const audioBuffer = await ctx.decodeAudioData(mp3Data.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        activeSourceRef.current = source;

        return new Promise<void>((resolve) => {
          source.onended = () => {
            if (activeSourceRef.current === source) {
              activeSourceRef.current = null;
            }
            resolve();
          };
          source.start();
        });
      } catch (err) {
        console.error("[SFU] Playback error:", err);
      }
    },
    [getAudioContext]
  );

  const processPlaybackQueue = useCallback(async () => {
    if (isPlayingRef.current || playbackQueueRef.current.length === 0) return;
    isPlayingRef.current = true;

    while (playbackQueueRef.current.length > 0) {
      const data = playbackQueueRef.current.shift()!;
      await playAudio(data);
    }

    isPlayingRef.current = false;
  }, [playAudio]);

  // Connect the WebSocket to VoiceAgent for control + transcripts
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const agentName = options.agent;
    const instanceName = options.name ?? "default";
    const wsUrl = `${protocol}//${window.location.host}/agents/${agentName}/${instanceName}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleJSONMessage(event.data);
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buf) => {
          playbackQueueRef.current.push(buf);
          processPlaybackQueue();
        });
      } else if (event.data instanceof ArrayBuffer) {
        playbackQueueRef.current.push(event.data);
        processPlaybackQueue();
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [options.agent, options.name, handleJSONMessage, processPlaybackQueue]);

  // Start WebRTC call through SFU
  const startCall = useCallback(async () => {
    if (!connected) return;

    try {
      setError(null);
      setMetrics(null);

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
      streamRef.current = stream;

      // 2. Create SFU session
      const sessionResp = await fetch("/sfu/session", { method: "POST" });
      const sessionData = (await sessionResp.json()) as {
        sessionId: string;
      };
      sessionIdRef.current = sessionData.sessionId;
      console.log("[SFU] Session created:", sessionData.sessionId);

      // 3. Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: STUN_SERVER }],
        bundlePolicy: "max-bundle"
      });
      pcRef.current = pc;

      pc.oniceconnectionstatechange = () => {
        setWebrtcState(pc.iceConnectionState);
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
        tracks?: Array<{ trackName: string; mid: string }>;
      };

      if (tracksData.sessionDescription) {
        await pc.setRemoteDescription({
          type: "answer",
          sdp: tracksData.sessionDescription.sdp
        });
      }

      // 7. Create SFU WebSocket adapter to stream user audio to our /sfu/audio-in
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

      // 8. Start monitoring local audio levels for silence detection
      const monitorCtx = new AudioContext();
      const source = monitorCtx.createMediaStreamSource(stream);
      const analyser = monitorCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Float32Array(analyser.fftSize);
      const monitorLoop = () => {
        analyser.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setAudioLevel(rms);

        // Silence detection (same logic as VoiceClient)
        if (rms > SILENCE_THRESHOLD) {
          isSpeakingRef.current = true;
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else if (isSpeakingRef.current) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              isSpeakingRef.current = false;
              silenceTimerRef.current = null;
              // Send end_of_speech through the direct WebSocket
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "end_of_speech" }));
              }
            }, SILENCE_DURATION_MS);
          }
        }

        animFrameRef.current = requestAnimationFrame(monitorLoop);
      };
      animFrameRef.current = requestAnimationFrame(monitorLoop);

      // 9. Send start_call through the direct WebSocket
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "start_call" }));
      }

      console.log("[SFU] Call started via WebRTC");
    } catch (err) {
      console.error("[SFU] Start call error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to start WebRTC call"
      );
    }
  }, [connected]);

  // End call
  const endCall = useCallback(() => {
    // Send end_call through WebSocket
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "end_call" }));
    }

    // Stop monitoring
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    // Stop peer connection
    pcRef.current?.close();
    pcRef.current = null;

    // Stop media stream
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    // Stop audio playback
    activeSourceRef.current?.stop();
    activeSourceRef.current = null;
    playbackQueueRef.current = [];
    isPlayingRef.current = false;

    // Close audio context
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;

    setStatus("idle");
    setAudioLevel(0);
    setWebrtcState("closed");
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const newMuted = !prev;
      // Mute/unmute the WebRTC track
      if (streamRef.current) {
        streamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = !newMuted;
        });
      }
      return newMuted;
    });
  }, []);

  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "text_message", text }));
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pcRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  return {
    status,
    transcript,
    metrics,
    audioLevel,
    isMuted,
    connected,
    error,
    webrtcState,
    startCall,
    endCall,
    toggleMute,
    sendText
  };
}
