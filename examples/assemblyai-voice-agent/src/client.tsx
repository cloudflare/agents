import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useVoiceAgent, type VoiceStatus } from "@cloudflare/voice/react";
import { Button, Surface, Text, PoweredByCloudflare } from "@cloudflare/kumo";
import {
  ArrowBendUpRightIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneIcon,
  PhoneXIcon,
  PaperPlaneRightIcon,
  WaveformIcon,
  WrenchIcon,
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

/** Server-sent "under the hood" event: agent_context updates + tool activity. */
interface DebugEvent {
  type: "debug_event";
  t: number;
  kind: "agent_context" | "tool_call" | "tool_result";
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
}

function isDebugEvent(msg: unknown): msg is DebugEvent {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "debug_event"
  );
}

function DebugEventRow({ event }: { event: DebugEvent }) {
  const time = new Date(event.t).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  if (event.kind === "agent_context") {
    return (
      <div className="flex gap-2 items-start">
        <span className="text-kumo-subtle shrink-0">{time}</span>
        <ArrowBendUpRightIcon
          size={14}
          weight="bold"
          className="text-kumo-brand shrink-0 mt-0.5"
        />
        <span>
          <span className="text-kumo-brand">agent_context → AssemblyAI </span>
          <span className="text-kumo-subtle">“{event.text}”</span>
        </span>
      </div>
    );
  }

  const isCall = event.kind === "tool_call";
  const payload = isCall ? event.input : event.output;
  return (
    <div className="flex gap-2 items-start">
      <span className="text-kumo-subtle shrink-0">{time}</span>
      <WrenchIcon
        size={14}
        weight="bold"
        className={`shrink-0 mt-0.5 ${isCall ? "text-amber-500" : "text-emerald-500"}`}
      />
      <span className="break-all">
        <span className={isCall ? "text-amber-500" : "text-emerald-500"}>
          {event.tool}
          {isCall ? "(" : " → "}
        </span>
        <span className="text-kumo-subtle">
          {JSON.stringify(payload)}
          {isCall ? ")" : ""}
        </span>
      </span>
    </div>
  );
}

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
    sendText,
    lastCustomMessage
  } = useVoiceAgent({
    agent: "AssemblyAIVoiceAgent",
    name: sessionId
  });

  const inCall = status !== "idle";
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const debugEndRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimTranscript]);

  // Collect "under the hood" events broadcast by the agent.
  useEffect(() => {
    if (isDebugEvent(lastCustomMessage)) {
      setDebugEvents((prev) => [...prev.slice(-99), lastCustomMessage]);
    }
  }, [lastCustomMessage]);

  useEffect(() => {
    debugEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [debugEvents]);

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
              Luna Rossa Reservations — AssemblyAI Voice Agent
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
                  ? "Listening… try “I’d like a table for four this Friday at seven.”"
                  : "Press “Start call”, allow the mic, and book a table."}
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

        {/* Under the hood: agent_context updates + tool activity */}
        <Surface className="rounded-xl ring ring-kumo-line">
          <div className="px-4 pt-3 pb-1 flex items-center justify-between">
            <Text size="xs" bold>
              Under the hood
            </Text>
            <Text size="xs">
              <span className="text-kumo-subtle">
                agent_context → AssemblyAI · tool calls · tool results
              </span>
            </Text>
          </div>
          <div className="px-4 pb-3 max-h-44 overflow-y-auto font-mono text-[11px] leading-5">
            {debugEvents.length === 0 ? (
              <span className="text-kumo-subtle italic">
                Start a call — you'll see the agent's spoken replies primed into
                AssemblyAI as context, and the LLM's reservation tools firing
                against the Durable Object's database.
              </span>
            ) : (
              debugEvents.map((e, i) => (
                <DebugEventRow key={`${e.t}-${i}`} event={e} />
              ))
            )}
            <div ref={debugEndRef} />
          </div>
        </Surface>
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
