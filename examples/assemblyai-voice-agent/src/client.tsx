import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useVoiceAgent, type VoiceStatus } from "@cloudflare/voice/react";
import { Button, Surface, Text, PoweredByCloudflare } from "@cloudflare/kumo";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneIcon,
  PhoneXIcon,
  PaperPlaneRightIcon,
  WaveformIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";
import "./styles.css";

// Stable per-tab instance name so reconnects hit the same agent.
function getSessionId(): string {
  const key = "assemblyai-voice-session";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking"
};

function AudioLevelBar({ level }: { level: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-kumo-tint overflow-hidden">
      <div
        className="h-full rounded-full bg-kumo-brand transition-all duration-75"
        style={{ width: `${Math.min(level * 500, 100)}%` }}
      />
    </div>
  );
}

function StatusPill({ status }: { status: VoiceStatus }) {
  const active = status !== "idle";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
        active
          ? "bg-kumo-fill text-kumo-brand"
          : "bg-kumo-tint text-kumo-subtle"
      }`}
    >
      <WaveformIcon size={12} weight="bold" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function App() {
  const sessionId = useRef(getSessionId()).current;

  const {
    status,
    transcript,
    interimTranscript,
    audioLevel,
    isMuted,
    connected,
    error,
    startCall,
    endCall,
    toggleMute,
    sendText
  } = useVoiceAgent({
    agent: "AssemblyAIVoiceAgent",
    name: sessionId
  });

  const inCall = status !== "idle";
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimTranscript]);

  const handleSend = () => {
    const text = textInput.trim();
    if (!text) return;
    sendText(text);
    setTextInput("");
  };

  return (
    <div className="min-h-full bg-kumo-base flex flex-col">
      {/* Header */}
      <header className="border-b border-kumo-line px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <WaveformIcon size={20} weight="bold" className="text-kumo-brand" />
          <span>
            <Text size="sm" bold>
              AssemblyAI Voice Agent
            </Text>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          <ModeToggle />
        </div>
      </header>

      {/* Conversation */}
      <main className="flex-1 p-4 max-w-2xl mx-auto w-full flex flex-col gap-4">
        <Surface className="rounded-xl ring ring-kumo-line flex-1 flex flex-col min-h-[320px]">
          <div className="flex-1 p-4 flex flex-col gap-3 overflow-y-auto">
            {transcript.length === 0 && !interimTranscript ? (
              <span className="text-kumo-subtle text-sm italic m-auto text-center">
                {inCall
                  ? "Listening… start speaking."
                  : "Press “Start call”, allow the mic, and say hello."}
              </span>
            ) : (
              <>
                {transcript.map((m, i) => (
                  <div
                    key={`${m.timestamp}-${i}`}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <span
                      className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                        m.role === "user"
                          ? "bg-kumo-brand text-white"
                          : "bg-kumo-fill text-kumo-default"
                      }`}
                    >
                      {m.text}
                    </span>
                  </div>
                ))}
                {interimTranscript && (
                  <div className="flex justify-end">
                    <span className="max-w-[80%] rounded-2xl px-3 py-2 text-sm italic text-kumo-subtle bg-kumo-tint">
                      {interimTranscript}
                    </span>
                  </div>
                )}
              </>
            )}
            <div ref={transcriptEndRef} />
          </div>

          {/* Audio level while in a call */}
          {inCall && (
            <div className="px-4 pb-2">
              <AudioLevelBar level={audioLevel} />
            </div>
          )}

          {/* Controls */}
          <div className="border-t border-kumo-line px-3 py-2 flex items-center gap-2">
            {!inCall ? (
              <Button
                size="sm"
                variant="primary"
                onClick={startCall}
                aria-label="Start call"
              >
                <PhoneIcon size={16} weight="bold" />
                Start call
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={endCall}
                  aria-label="End call"
                >
                  <PhoneXIcon size={16} weight="bold" />
                  End call
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={toggleMute}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? (
                    <MicrophoneSlashIcon size={16} weight="bold" />
                  ) : (
                    <MicrophoneIcon size={16} weight="bold" />
                  )}
                  {isMuted ? "Unmute" : "Mute"}
                </Button>
              </>
            )}

            {/* Type instead of speak */}
            <div className="flex-1 flex items-center gap-1">
              <input
                className="flex-1 rounded-lg bg-kumo-tint px-3 py-1.5 text-sm text-kumo-default outline-none placeholder:text-kumo-subtle"
                aria-label="Type a message"
                placeholder="…or type a message"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSend();
                }}
                disabled={!connected}
              />
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                onClick={handleSend}
                disabled={!connected || !textInput.trim()}
                aria-label="Send message"
                icon={<PaperPlaneRightIcon size={16} weight="bold" />}
              />
            </div>
          </div>
        </Surface>

        {error && (
          <Surface className="p-3 rounded-xl ring ring-red-500/30 bg-red-500/10">
            <Text size="xs">{error}</Text>
          </Surface>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-kumo-line px-4 py-3 flex items-center justify-center">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </footer>
    </div>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
