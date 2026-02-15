import { useEffect, useRef, useState, useCallback, useMemo } from "react";
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

/** Options accepted by useVoiceAgent. */
export interface UseVoiceAgentOptions extends VoiceClientOptions {
  /**
   * Called when the hook reconnects due to option changes (e.g., agent name
   * or instance name changed). Use this to show a toast or notification.
   */
  onReconnect?: () => void;
}

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
  sendText: (text: string) => void;
}

/**
 * React hook that wraps VoiceClient, syncing its state into React state.
 * All audio infrastructure (mic capture, playback, silence/interrupt detection,
 * voice protocol) is handled by VoiceClient — this hook just bridges to React.
 *
 * When the connection identity changes (agent, name, or host), the hook
 * automatically disconnects the old client, creates a new one, and reconnects.
 * The `onReconnect` callback fires when this happens.
 */
export function useVoiceAgent(
  options: UseVoiceAgentOptions
): UseVoiceAgentReturn {
  // Derive a stable key from the connection-identity fields.
  // When this changes, we tear down the old client and create a new one.
  const connectionKey = useMemo(
    () => `${options.agent}:${options.name ?? "default"}:${options.host ?? ""}`,
    [options.agent, options.name, options.host]
  );

  const clientRef = useRef<VoiceClient | null>(null);
  const prevKeyRef = useRef(connectionKey);
  const onReconnectRef = useRef(options.onReconnect);
  onReconnectRef.current = options.onReconnect;

  // React state mirrors VoiceClient state
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connect on mount or when connection identity changes
  useEffect(() => {
    const isReconnect = prevKeyRef.current !== connectionKey;
    prevKeyRef.current = connectionKey;

    // Fire reconnect callback (e.g., to show a toast)
    if (isReconnect) {
      onReconnectRef.current?.();
    }

    // Reset state for a fresh connection
    setStatus("idle");
    setTranscript([]);
    setMetrics(null);
    setAudioLevel(0);
    setIsMuted(false);
    setConnected(false);
    setError(null);

    const client = new VoiceClient(options);
    clientRef.current = client;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect when connection identity changes
  }, [connectionKey]);

  // Stable action callbacks — always use the latest client
  const startCall = useCallback(() => clientRef.current!.startCall(), []);
  const endCall = useCallback(() => clientRef.current!.endCall(), []);
  const toggleMute = useCallback(() => clientRef.current!.toggleMute(), []);
  const sendText = useCallback(
    (text: string) => clientRef.current!.sendText(text),
    []
  );

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
    toggleMute,
    sendText
  };
}
