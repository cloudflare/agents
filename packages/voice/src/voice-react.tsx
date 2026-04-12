import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  VoiceClient,
  type VoiceClientOptions,
  type VoiceStatus,
  type TranscriptMessage,
  type VoicePipelineMetrics
} from "./voice-client";

// Re-export types so consumers can import everything from agents/voice-react
export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceTransport,
  TranscriptMessage,
  VoicePipelineMetrics,
  VoiceClientOptions,
  VoiceClientEvent,
  VoiceClientEventMap
} from "./voice-client";
export { WebSocketVoiceTransport } from "./voice-client";

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
  /**
   * The current interim (partial) transcript from streaming STT.
   * Updates in real time as the user speaks. null when not available.
   */
  interimTranscript: string | null;
  metrics: VoicePipelineMetrics | null;
  audioLevel: number;
  isMuted: boolean;
  connected: boolean;
  error: string | null;
  startCall: () => Promise<void>;
  endCall: () => void;
  toggleMute: () => void;
  sendText: (text: string) => void;
  /** Send arbitrary JSON to the agent (app-level messages). */
  sendJSON: (data: Record<string, unknown>) => void;
  /** The last non-voice-protocol message received from the server. */
  lastCustomMessage: unknown;
}

// ---------------------------------------------------------------------------
// useVoiceInput — lightweight hook for voice-to-text dictation
// ---------------------------------------------------------------------------

/** Options accepted by useVoiceInput. */
export interface UseVoiceInputOptions {
  /** Agent name (matches the server-side Durable Object class). */
  agent: string;
  /** Instance name for the agent. @default "default" */
  name?: string;
  /** Host to connect to. @default window.location.host */
  host?: string;

  /** RMS threshold below which audio is considered silence. @default 0.04 */
  silenceThreshold?: number;
  /** How long silence must last before sending end_of_speech (ms). @default 500 */
  silenceDurationMs?: number;
}

export interface UseVoiceInputReturn {
  /** Accumulated final transcript text from all utterances. */
  transcript: string;
  /**
   * Current interim (partial) transcript from streaming STT.
   * Updates in real time as the user speaks. null when not available.
   */
  interimTranscript: string | null;
  /** Whether the mic is actively listening. */
  isListening: boolean;
  /** Current audio level (0–1) for visual feedback (e.g. waveform). */
  audioLevel: number;
  /** Whether the mic is muted. */
  isMuted: boolean;
  /** Any error message. */
  error: string | null;
  /** Start listening — requests mic permission and begins streaming audio. */
  start: () => Promise<void>;
  /** Stop listening — releases the mic. */
  stop: () => void;
  /** Toggle mute (mic stays open but audio is not sent). */
  toggleMute: () => void;
  /** Clear the accumulated transcript. */
  clear: () => void;
}

/**
 * React hook for voice-to-text input. Captures microphone audio, streams it
 * to a server-side VoiceAgent for STT, and returns the transcript as a string.
 *
 * Unlike `useVoiceAgent`, this hook is optimised for dictation — it accumulates
 * user transcripts into a single string and ignores assistant responses / TTS.
 *
 * @example
 * ```tsx
 * const { transcript, interimTranscript, isListening, start, stop } = useVoiceInput({
 *   agent: "voice-input-agent"
 * });
 *
 * <textarea value={transcript + (interimTranscript ? " " + interimTranscript : "")} />
 * <button onClick={isListening ? stop : start}>
 *   {isListening ? "Stop" : "Dictate"}
 * </button>
 * ```
 */
export function useVoiceInput(
  options: UseVoiceInputOptions
): UseVoiceInputReturn {
  const connectionKey = useMemo(
    () =>
      `${options.agent}:${options.name ?? "default"}:${options.host ?? ""}:${options.silenceThreshold ?? ""}:${options.silenceDurationMs ?? ""}`,
    [
      options.agent,
      options.name,
      options.host,
      options.silenceThreshold,
      options.silenceDurationMs
    ]
  );

  const clientRef = useRef<VoiceClient | null>(null);

  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState<string | null>(
    null
  );
  const [isListening, setIsListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connect on mount or when connection identity changes
  useEffect(() => {
    setIsListening(false);
    setInterimTranscript(null);
    setAudioLevel(0);
    setIsMuted(false);
    setError(null);

    const client = new VoiceClient({
      agent: options.agent,
      name: options.name,
      host: options.host,
      silenceThreshold: options.silenceThreshold,
      silenceDurationMs: options.silenceDurationMs
    });
    clientRef.current = client;
    client.connect();

    // Sync user transcripts into a single accumulated string
    const onTranscript = () => {
      const msgs = client.transcript;
      const userTexts = msgs
        .filter((m) => m.role === "user")
        .map((m) => m.text);
      setTranscript(userTexts.join(" "));
    };

    const onInterim = () => setInterimTranscript(client.interimTranscript);
    const onAudioLevel = () => setAudioLevel(client.audioLevel);
    const onMute = () => setIsMuted(client.isMuted);
    const onError = () => setError(client.error);

    const onStatus = () => {
      const s = client.status;
      setIsListening(s === "listening" || s === "thinking");
    };

    client.addEventListener("transcriptchange", onTranscript);
    client.addEventListener("interimtranscript", onInterim);
    client.addEventListener("audiolevelchange", onAudioLevel);
    client.addEventListener("mutechange", onMute);
    client.addEventListener("error", onError);
    client.addEventListener("statuschange", onStatus);

    return () => {
      client.removeEventListener("transcriptchange", onTranscript);
      client.removeEventListener("interimtranscript", onInterim);
      client.removeEventListener("audiolevelchange", onAudioLevel);
      client.removeEventListener("mutechange", onMute);
      client.removeEventListener("error", onError);
      client.removeEventListener("statuschange", onStatus);
      client.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect when connection identity changes
  }, [connectionKey]);

  const start = useCallback(() => clientRef.current!.startCall(), []);
  const stop = useCallback(() => clientRef.current!.endCall(), []);
  const toggleMute = useCallback(() => clientRef.current!.toggleMute(), []);
  const clear = useCallback(() => setTranscript(""), []);

  return {
    transcript,
    interimTranscript,
    isListening,
    audioLevel,
    isMuted,
    error,
    start,
    stop,
    toggleMute,
    clear
  };
}

// ---------------------------------------------------------------------------
// useVoiceAgent — full-featured hook for conversational voice agents
// ---------------------------------------------------------------------------

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
  const queryString = useMemo(
    () => (options.query ? JSON.stringify(options.query) : ""),
    [options.query]
  );

  const connectionKey = useMemo(
    () =>
      `${options.agent}:${options.name ?? "default"}:${options.host ?? ""}:${options.silenceThreshold ?? ""}:${options.silenceDurationMs ?? ""}:${options.interruptThreshold ?? ""}:${options.interruptChunks ?? ""}:${queryString}`,
    [
      options.agent,
      options.name,
      options.host,
      options.silenceThreshold,
      options.silenceDurationMs,
      options.interruptThreshold,
      options.interruptChunks,
      queryString
    ]
  );

  const clientRef = useRef<VoiceClient | null>(null);
  const prevKeyRef = useRef(connectionKey);
  const onReconnectRef = useRef(options.onReconnect);
  onReconnectRef.current = options.onReconnect;

  // React state mirrors VoiceClient state
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [metrics, setMetrics] = useState<VoicePipelineMetrics | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interimTranscript, setInterimTranscript] = useState<string | null>(
    null
  );

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
    setInterimTranscript(null);

    const client = new VoiceClient(options);
    clientRef.current = client;
    client.connect();

    // Sync handlers — read state from client and push to React
    const onStatus = (s: VoiceStatus) => setStatus(s);
    const onTranscript = (t: TranscriptMessage[]) => setTranscript(t);
    const onMetrics = (m: VoicePipelineMetrics | null) => setMetrics(m);
    const onAudioLevel = (level: number) => setAudioLevel(level);
    const onMute = (muted: boolean) => setIsMuted(muted);
    const onConnection = (c: boolean) => setConnected(c);
    const onError = (e: string | null) => setError(e);
    const onInterim = (text: string | null) => setInterimTranscript(text);

    client.addEventListener("statuschange", onStatus);
    client.addEventListener("transcriptchange", onTranscript);
    client.addEventListener("interimtranscript", onInterim);
    client.addEventListener("metricschange", onMetrics);
    client.addEventListener("audiolevelchange", onAudioLevel);
    client.addEventListener("mutechange", onMute);
    client.addEventListener("connectionchange", onConnection);
    client.addEventListener("error", onError);

    return () => {
      client.removeEventListener("statuschange", onStatus);
      client.removeEventListener("transcriptchange", onTranscript);
      client.removeEventListener("interimtranscript", onInterim);
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
  const sendJSON = useCallback(
    (data: Record<string, unknown>) => clientRef.current!.sendJSON(data),
    []
  );

  const [lastCustomMessage, setLastCustomMessage] = useState<unknown>(null);

  // Listen for custom messages — needs a separate effect since it must
  // attach to the latest client.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    const onCustom = (msg: unknown) => setLastCustomMessage(msg);
    client.addEventListener("custommessage", onCustom);
    return () => client.removeEventListener("custommessage", onCustom);
  }, [connectionKey]);

  return {
    status,
    transcript,
    interimTranscript,
    metrics,
    audioLevel,
    isMuted,
    connected,
    error,
    startCall,
    endCall,
    toggleMute,
    sendText,
    sendJSON,
    lastCustomMessage
  };
}
