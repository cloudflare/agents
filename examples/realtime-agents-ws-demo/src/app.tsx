import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { Button, Badge, Surface, Text } from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Switch } from "@cloudflare/kumo";
import {
  StopIcon,
  TrashIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  BugIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PlayIcon
} from "@phosphor-icons/react";
import { useAudioCapture } from "./hooks/useAudioCapture";
import { useAudioPlayback } from "./hooks/useAudioPlayback";

// ── Types for voice transcriptions ────────────────────────────────────

type TranscriptionEntry = {
  id: string;
  source: "client" | "agent";
  text: string;
  timestamp: number;
};

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Transcription Bubble (voice messages) ─────────────────────────────

function TranscriptionBubble({ entry }: { entry: TranscriptionEntry }) {
  const isAgent = entry.source === "agent";
  return (
    <div className={`flex ${isAgent ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] px-4 py-2.5 leading-relaxed ${
          isAgent
            ? "rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default"
            : "rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <MicrophoneIcon size={12} className="opacity-50" />
          <span className="text-xs opacity-70">
            {isAgent ? "Agent (voice)" : "You (voice)"}
          </span>
        </div>
        {entry.text}
      </div>
    </div>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>(
    []
  );
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const toasts = useKumoToastManager();
  const sessionId = useRef(crypto.randomUUID()).current;
  const agentIdRef = useRef(sessionId);

  // ── Audio playback ──
  const { playAudio } = useAudioPlayback();

  // ── Agent connection ──
  const agent = useAgent({
    agent: "VoiceAgent",
    name: agentIdRef.current,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));

          // Handle incoming audio from pipeline
          if (data.type === "media" && data.payload?.content_type === "audio") {
            playAudio(data.payload.data);
            return;
          }

          // Handle voice transcription
          if (data.type === "transcription") {
            const entry: TranscriptionEntry = {
              id: crypto.randomUUID(),
              source: data.source as "client" | "agent",
              text: data.text,
              timestamp: Date.now()
            };
            setTranscriptions((prev) => [...prev, entry]);
            return;
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [playAudio]
    )
  });

  // ── Audio capture (PTT) ──
  const sendAudioChunk = useCallback(
    (base64Audio: string) => {
      console.log("sending audio chunk");
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(
          JSON.stringify({
            type: "media",
            version: 1,
            identifier: sessionId,
            payload: {
              content_type: "audio",
              context_id: null,
              data: base64Audio
            }
          })
        );
      }
    },
    [agent, sessionId]
  );

  const { isCapturing, startCapture, stopCapture } =
    useAudioCapture(sendAudioChunk);

  const handlePTTStart = useCallback(() => {
    startCapture();
  }, [startCapture]);

  const handlePTTEnd = useCallback(() => {
    stopCapture();
  }, [stopCapture]);

  // ── Pipeline start/stop ──
  const startPipeline = useCallback(async () => {
    setPipelineLoading(true);
    try {
      const res = await fetch(
        `/agents/voice-agent/${agentIdRef.current}/realtime/start`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to start pipeline: ${res.status} ${text}`);
      }
      setPipelineRunning(true);
      toasts.add({
        title: "Pipeline started",
        description: "Voice pipeline is now active",
        timeout: 3000
      });
    } catch (err) {
      console.error("Failed to start pipeline:", err);
      toasts.add({
        title: "Pipeline error",
        description: String(err),
        timeout: 0
      });
    } finally {
      setPipelineLoading(false);
    }
  }, [toasts]);

  const stopPipeline = useCallback(async () => {
    setPipelineLoading(true);
    try {
      const res = await fetch(
        `/agents/voice-agent/${agentIdRef.current}/realtime/stop`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to stop pipeline: ${res.status} ${text}`);
      }
      setPipelineRunning(false);
      toasts.add({
        title: "Pipeline stopped",
        description: "Voice pipeline has been stopped",
        timeout: 3000
      });
    } catch (err) {
      console.error("Failed to stop pipeline:", err);
      toasts.add({
        title: "Pipeline error",
        description: String(err),
        timeout: 0
      });
    } finally {
      setPipelineLoading(false);
    }
  }, [toasts]);

  const handleClear = useCallback(() => {
    setTranscriptions([]);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptions]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              <span className="mr-2">🎙️</span>Realtime Voice Agent
            </h1>
            <Badge variant="secondary">
              <MicrophoneIcon size={12} weight="bold" className="mr-1" />
              Voice
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClear}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {transcriptions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-6">
              <ChatCircleDotsIcon size={48} className="text-kumo-inactive" />
              <div className="text-center space-y-2">
                <Text size="lg" bold>
                  Realtime Voice Agent
                </Text>
                <Text size="sm" variant="secondary">
                  {!pipelineRunning
                    ? "Start the pipeline, then hold the microphone button to speak"
                    : "Hold the microphone button to speak"}
                </Text>
              </div>

              {!pipelineRunning && (
                <Button
                  variant="primary"
                  icon={<PlayIcon size={16} />}
                  onClick={startPipeline}
                  disabled={!connected || pipelineLoading}
                >
                  {pipelineLoading ? "Starting..." : "Start Voice Pipeline"}
                </Button>
              )}
            </div>
          )}

          {showDebug && (
            <Surface className="px-4 py-2.5 rounded-xl ring ring-kumo-line">
              <pre className="text-[11px] text-kumo-subtle overflow-auto max-h-48">
                {JSON.stringify(
                  {
                    connected,
                    pipelineRunning,
                    pipelineLoading,
                    agentId: agentIdRef.current,
                    transcriptionCount: transcriptions.length,
                    isCapturing
                  },
                  null,
                  2
                )}
              </pre>
            </Surface>
          )}

          {transcriptions.map((entry) => (
            <TranscriptionBubble key={entry.id} entry={entry} />
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <div className="max-w-3xl mx-auto px-5 py-4">
          <div className="flex items-center justify-center gap-4">
            {/* Pipeline control */}
            {pipelineRunning ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<StopIcon size={14} />}
                onClick={stopPipeline}
                disabled={pipelineLoading}
              >
                Stop Pipeline
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={<PlayIcon size={14} />}
                onClick={startPipeline}
                disabled={!connected || pipelineLoading}
              >
                {pipelineLoading ? "Starting..." : "Start Pipeline"}
              </Button>
            )}

            {/* Push-to-talk button */}
            <Button
              type="button"
              variant={isCapturing ? "primary" : "secondary"}
              shape="square"
              aria-label={isCapturing ? "Release to stop" : "Hold to speak"}
              icon={
                isCapturing ? (
                  <MicrophoneIcon size={24} weight="fill" />
                ) : connected && pipelineRunning ? (
                  <MicrophoneIcon size={24} />
                ) : (
                  <MicrophoneSlashIcon size={24} />
                )
              }
              disabled={!connected || !pipelineRunning}
              onPointerDown={(e: React.PointerEvent) => {
                if (!connected || !pipelineRunning) return;
                e.preventDefault();
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                handlePTTStart();
              }}
              onPointerUp={(e: React.PointerEvent) => {
                e.preventDefault();
                if (isCapturing) handlePTTEnd();
              }}
              onPointerCancel={(e: React.PointerEvent) => {
                e.preventDefault();
                if (isCapturing) handlePTTEnd();
              }}
              className={`!w-16 !h-16 touch-none select-none ${isCapturing ? "animate-pulse" : ""}`}
            />

            {/* Pipeline status */}
            <div className="flex items-center gap-1.5 min-w-[100px]">
              <CircleIcon
                size={8}
                weight="fill"
                className={
                  pipelineRunning ? "text-kumo-success" : "text-kumo-inactive"
                }
              />
              <Text size="xs" variant="secondary">
                {pipelineRunning ? "Pipeline active" : "Pipeline idle"}
              </Text>
            </div>
          </div>

          {/* PTT status indicator */}
          {isCapturing && (
            <div className="flex items-center justify-center gap-2 mt-3 text-sm text-kumo-brand">
              <MicrophoneIcon
                size={14}
                weight="fill"
                className="animate-pulse"
              />
              Listening... release to stop
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
