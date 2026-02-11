import { useEffect, useRef, useState, useCallback } from "react";
import {
  VoiceClient,
  type VoiceClientOptions,
  type VoiceStatus,
  type TranscriptMessage,
  type PipelineMetrics
} from "./voice-client";

// Re-export types so consumers can import everything from agents/voice-react
export type {
  VoiceStatus,
  TranscriptMessage,
  PipelineMetrics,
  VoiceClientOptions
} from "./voice-client";

/** Options accepted by useVoiceAgent — same shape as VoiceClientOptions. */
export type UseVoiceAgentOptions = VoiceClientOptions;

export interface UseVoiceAgentReturn {
  status: VoiceStatus;
  transcript: TranscriptMessage[];
  metrics: PipelineMetrics | null;
  audioLevel: number;
  isMuted: boolean;
  connected: boolean;
  error: string | null;
  startCall: () => Promise<void>;
  endCall: () => void;
  toggleMute: () => void;
}

/**
 * React hook that wraps VoiceClient, syncing its state into React state.
 * All audio infrastructure (mic capture, playback, silence/interrupt detection,
 * voice protocol) is handled by VoiceClient — this hook just bridges to React.
 */
export function useVoiceAgent(
  options: UseVoiceAgentOptions
): UseVoiceAgentReturn {
  const clientRef = useRef<VoiceClient | null>(null);

  // Lazily create the VoiceClient (stable across renders)
  if (!clientRef.current) {
    clientRef.current = new VoiceClient(options);
  }

  // React state mirrors VoiceClient state
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    const client = clientRef.current!;
    client.connect();

    // Sync handlers — read state from client and push to React
    const onStatus = () => setStatus(client.status);
    const onTranscript = () => setTranscript(client.transcript);
    const onMetrics = () => setMetrics(client.metrics);
    const onAudioLevel = () => setAudioLevel(client.audioLevel);
    const onMute = () => setIsMuted(client.isMuted);
    const onConnection = () => setConnected(client.connected);
    const onError = () => setError(client.error);

    client.addEventListener("statuschange", onStatus);
    client.addEventListener("transcriptchange", onTranscript);
    client.addEventListener("metricschange", onMetrics);
    client.addEventListener("audiolevelchange", onAudioLevel);
    client.addEventListener("mutechange", onMute);
    client.addEventListener("connectionchange", onConnection);
    client.addEventListener("error", onError);

    return () => {
      client.removeEventListener("statuschange", onStatus);
      client.removeEventListener("transcriptchange", onTranscript);
      client.removeEventListener("metricschange", onMetrics);
      client.removeEventListener("audiolevelchange", onAudioLevel);
      client.removeEventListener("mutechange", onMute);
      client.removeEventListener("connectionchange", onConnection);
      client.removeEventListener("error", onError);
      client.disconnect();
    };
  }, []);

  // Stable action callbacks
  const startCall = useCallback(() => clientRef.current!.startCall(), []);
  const endCall = useCallback(() => clientRef.current!.endCall(), []);
  const toggleMute = useCallback(() => clientRef.current!.toggleMute(), []);

  return {
    status,
    transcript,
    metrics,
    audioLevel,
    isMuted,
    connected,
    error,
    startCall,
    endCall,
    toggleMute
  };
}
