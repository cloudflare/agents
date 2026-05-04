import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVoiceAgent, type VoiceStatus } from "@cloudflare/voice/react";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ChatCircleDotsIcon,
  InfoIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
  SpinnerGapIcon,
  SunIcon,
  WaveformIcon,
  WifiHighIcon,
  WifiSlashIcon
} from "@phosphor-icons/react";
import "./styles.css";

function getSessionId(): string {
  const key = "telnyx-voice-agent-session-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
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

function ConnectionIndicator({ connected }: { connected: boolean }) {
  const Icon = connected ? WifiHighIcon : WifiSlashIcon;
  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          connected ? "bg-kumo-success" : "bg-kumo-secondary"
        }`}
      />
      <Icon size={16} className="text-kumo-secondary" />
      <Text size="sm" variant="secondary">
        {connected ? "Connected" : "Disconnected"}
      </Text>
    </div>
  );
}

function statusLabel(status: VoiceStatus): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "listening":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
  }
}

function statusIcon(status: VoiceStatus) {
  switch (status) {
    case "idle":
      return <PhoneIcon size={16} />;
    case "listening":
      return <WaveformIcon size={16} />;
    case "thinking":
      return <SpinnerGapIcon size={16} className="animate-spin" />;
    case "speaking":
      return <ChatCircleDotsIcon size={16} />;
  }
}

function App() {
  const sessionId = useRef(getSessionId()).current;
  const [text, setText] = useState("");

  const {
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
    sendText
  } = useVoiceAgent({
    agent: "my-voice-agent",
    name: sessionId
  });

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimTranscript]);

  const inCall = status !== "idle";

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
        <header className="flex items-center justify-between gap-3">
          <div>
            <Text size="2xl" bold>
              Telnyx Voice Agent
            </Text>
            <span className="block">
              <Text size="sm" variant="secondary">
                Cloudflare Agents + Telnyx STT/TTS + Workers AI
              </Text>
            </span>
          </div>
          <ModeToggle />
        </header>

        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                Browser voice starter
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Click Start talking, speak into your microphone, and hear a
                  Workers AI assistant respond using Telnyx text-to-speech.
                  Telephony helpers are included in the provider package but are
                  optional for this starter UI.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <div className="grid flex-1 gap-4 lg:grid-cols-[0.8fr_1.2fr]">
          <Surface className="rounded-2xl p-5 ring ring-kumo-line">
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-center justify-between gap-3">
                <ConnectionIndicator connected={connected} />
                <Badge>
                  <span className="inline-flex items-center gap-1.5">
                    {statusIcon(status)}
                    {statusLabel(status)}
                  </span>
                </Badge>
              </div>

              <div>
                <Text size="sm" bold>
                  Microphone level
                </Text>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-kumo-line">
                  <div
                    className="h-full rounded-full bg-kumo-accent transition-all"
                    style={{ width: `${Math.min(100, audioLevel * 200)}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {!inCall ? (
                  <Button
                    onClick={startCall}
                    icon={<MicrophoneIcon size={16} />}
                  >
                    Start talking
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={endCall}
                    icon={<PhoneDisconnectIcon size={16} />}
                  >
                    End call
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={!inCall}
                  onClick={toggleMute}
                  icon={
                    isMuted ? (
                      <MicrophoneIcon size={16} />
                    ) : (
                      <MicrophoneSlashIcon size={16} />
                    )
                  }
                >
                  {isMuted ? "Unmute" : "Mute"}
                </Button>
              </div>

              {metrics ? (
                <Surface className="rounded-xl p-3 ring ring-kumo-line">
                  <Text size="xs" variant="secondary">
                    LLM {metrics.llm_ms}ms · TTS {metrics.tts_ms}ms · first
                    audio {metrics.first_audio_ms}ms · total {metrics.total_ms}
                    ms
                  </Text>
                </Surface>
              ) : null}

              {error ? (
                <Surface className="rounded-xl p-3 ring ring-kumo-danger">
                  <Text size="sm">{error}</Text>
                </Surface>
              ) : null}

              <div className="mt-auto">
                <PoweredByCloudflare />
              </div>
            </div>
          </Surface>

          <Surface className="flex min-h-[560px] flex-col rounded-2xl p-5 ring ring-kumo-line">
            <div className="mb-4 flex items-center gap-2">
              <ChatCircleDotsIcon size={20} className="text-kumo-accent" />
              <Text size="lg" bold>
                Transcript
              </Text>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-auto pr-1">
              {transcript.length === 0 && !interimTranscript ? (
                <Surface className="rounded-xl p-4 ring ring-kumo-line">
                  <Text size="sm" variant="secondary">
                    Start a call and say hello, or type a message below.
                  </Text>
                </Surface>
              ) : null}

              {transcript.map((message, index) => (
                <div
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                  key={`${message.timestamp}-${index}`}
                >
                  <Surface
                    className={`max-w-[82%] rounded-2xl p-3 ring ring-kumo-line ${
                      message.role === "user" ? "bg-kumo-accent" : ""
                    }`}
                  >
                    <Text size="xs" bold>
                      {message.role === "user" ? "You" : "Assistant"}
                    </Text>
                    <span className="mt-1 block">
                      <Text size="sm">{message.text}</Text>
                    </span>
                  </Surface>
                </div>
              ))}

              {interimTranscript ? (
                <div className="flex justify-end opacity-70">
                  <Surface className="max-w-[82%] rounded-2xl bg-kumo-accent p-3 ring ring-kumo-line">
                    <Text size="xs" bold>
                      You
                    </Text>
                    <span className="mt-1 block">
                      <Text size="sm">{interimTranscript}</Text>
                    </span>
                  </Surface>
                </div>
              ) : null}
              <div ref={transcriptEndRef} />
            </div>

            <form
              className="mt-4 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = text.trim();
                if (!value) return;
                sendText(value);
                setText("");
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-full border border-kumo-line bg-kumo-surface px-4 py-2 text-kumo-default outline-none focus:border-kumo-accent"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Or type a message..."
              />
              <Button type="submit" icon={<PaperPlaneRightIcon size={16} />}>
                Send
              </Button>
            </form>
          </Surface>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
