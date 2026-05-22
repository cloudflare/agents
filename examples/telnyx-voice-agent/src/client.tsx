import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";
import type {
  TranscriptMessage,
  VoicePipelineMetrics,
  VoiceStatus
} from "@cloudflare/voice/client";
import {
  createTelnyxVoiceConfig,
  TelnyxPhoneClient
} from "@cloudflare/voice-telnyx/browser";
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
  const key = "telnyx-phone-voice-agent-session-id";
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
        {connected ? "Worker connected" : "Worker disconnected"}
      </Text>
    </div>
  );
}

function statusLabel(status: VoiceStatus): string {
  switch (status) {
    case "idle":
      return "Waiting";
    case "listening":
      return "Listening to phone";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking into call";
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
  const phoneClientRef = useRef<TelnyxPhoneClient | null>(null);
  const cleanupRef = useRef<(() => Promise<void>) | null>(null);
  const callStartedRef = useRef(false);
  const connectAttemptRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [bridgeStatus, setBridgeStatus] = useState(
    "Connect the bridge, then call your Telnyx number."
  );
  const [sipUsername, setSipUsername] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [interimTranscript, setInterimTranscript] = useState<string | null>(
    null
  );
  const [metrics, setMetrics] = useState<VoicePipelineMetrics | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimTranscript]);

  useEffect(() => {
    return () => {
      connectAttemptRef.current++;
      phoneClientRef.current?.disconnect();
      void cleanupRef.current?.();
    };
  }, []);

  async function cleanupCurrentBridge() {
    phoneClientRef.current?.disconnect();
    phoneClientRef.current = null;
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    await cleanup?.();
  }

  async function connectBridge() {
    const attempt = connectAttemptRef.current + 1;
    connectAttemptRef.current = attempt;
    setConnecting(true);
    setError(null);
    setBridgeStatus("Fetching a Telnyx WebRTC token...");

    try {
      await cleanupCurrentBridge();
      if (connectAttemptRef.current !== attempt) return;

      const telnyx = await createTelnyxVoiceConfig({
        jwtEndpoint: "/api/telnyx-token",
        autoAnswer: true,
        debug: false
      });

      if (connectAttemptRef.current !== attempt) {
        await telnyx.cleanup();
        return;
      }

      cleanupRef.current = telnyx.cleanup;
      setSipUsername(telnyx.sipUsername || null);
      setBridgeStatus("Opening the Worker voice WebSocket...");

      const phoneClient = new TelnyxPhoneClient({
        transport: new WebSocketVoiceTransport({
          agent: "my-voice-agent",
          name: sessionId
        }),
        bridge: telnyx.bridge
      });

      phoneClient.addEventListener("statuschange", setVoiceStatus);
      phoneClient.addEventListener("transcriptchange", setTranscript);
      phoneClient.addEventListener("interimtranscript", setInterimTranscript);
      phoneClient.addEventListener("metricschange", setMetrics);
      phoneClient.addEventListener("audiolevelchange", setAudioLevel);
      phoneClient.addEventListener("mutechange", setIsMuted);
      phoneClient.addEventListener("error", setError);
      phoneClient.addEventListener("connectionchange", (isConnected) => {
        if (connectAttemptRef.current !== attempt) return;
        setConnected(isConnected);
        if (!isConnected) {
          setBridgeStatus("Worker connection dropped; reconnecting...");
          return;
        }

        setConnecting(false);

        if (callStartedRef.current) {
          setBridgeStatus("Worker reconnected. Phone bridge is still active.");
          return;
        }

        callStartedRef.current = true;
        setBridgeStatus("Connecting to Telnyx and waiting for a phone call...");
        phoneClient.startCall().then(
          () => {
            setBridgeStatus(
              "Bridge ready. Call your Telnyx number; inbound calls are auto-answered."
            );
          },
          (err: unknown) => {
            callStartedRef.current = false;
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setBridgeStatus("Failed to start the Telnyx phone bridge.");
          }
        );
      });

      if (connectAttemptRef.current !== attempt) {
        phoneClient.disconnect();
        await telnyx.cleanup();
        return;
      }

      phoneClientRef.current = phoneClient;
      phoneClient.connect();
    } catch (err) {
      await cleanupRef.current?.();
      cleanupRef.current = null;

      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setBridgeStatus("Setup failed.");
      setConnecting(false);
      callStartedRef.current = false;
    }
  }

  async function disconnectBridge() {
    connectAttemptRef.current++;
    try {
      await cleanupCurrentBridge();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }

    setConnected(false);
    setConnecting(false);
    callStartedRef.current = false;
    setVoiceStatus("idle");
    setBridgeStatus("Disconnected. Connect again to create a fresh bridge.");
    setSipUsername(null);
    setInterimTranscript(null);
    setMetrics(null);
    setAudioLevel(0);
    setIsMuted(false);
  }

  function toggleMute() {
    phoneClientRef.current?.toggleMute();
  }

  const canSendText = connected && phoneClientRef.current !== null;
  const bridgeActive =
    connected || connecting || phoneClientRef.current !== null;

  return (
    <main className="min-h-screen bg-kumo-base text-kumo-default">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
        <header className="flex items-center justify-between gap-3">
          <div>
            <Text size="lg" bold>
              Telnyx Phone Voice Agent
            </Text>
            <span className="block">
              <Text size="sm" variant="secondary">
                Cloudflare Agents + Telnyx PSTN/WebRTC bridge + Workers AI
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
                Phone/PSTN bridge demo
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  This browser is a control panel and WebRTC bridge. Caller
                  audio comes from a Telnyx phone call, streams to a Cloudflare
                  Agent for STT → LLM → TTS, then plays back into the same phone
                  call — not through the browser microphone or speakers.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <div className="grid flex-1 gap-4 lg:grid-cols-[0.85fr_1.15fr]">
          <Surface className="rounded-2xl p-5 ring ring-kumo-line">
            <div className="flex h-full flex-col gap-5">
              <div className="flex items-center justify-between gap-3">
                <ConnectionIndicator connected={connected} />
                <Badge>
                  <span className="inline-flex items-center gap-1.5">
                    {statusIcon(voiceStatus)}
                    {statusLabel(voiceStatus)}
                  </span>
                </Badge>
              </div>

              <Surface className="rounded-xl p-4 ring ring-kumo-line">
                <Text size="sm" bold>
                  Bridge status
                </Text>
                <span className="mt-2 block">
                  <Text size="sm" variant="secondary">
                    {bridgeStatus}
                  </Text>
                </span>
                {sipUsername ? (
                  <span className="mt-3 block rounded-lg bg-kumo-subtle p-3 font-mono text-sm">
                    sip:{sipUsername}@sip.telnyx.com
                  </span>
                ) : null}
              </Surface>

              <div>
                <Text size="sm" bold>
                  Phone audio level
                </Text>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-kumo-line">
                  <div
                    className="h-full rounded-full bg-kumo-accent transition-all"
                    style={{ width: `${Math.min(100, audioLevel * 200)}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {!bridgeActive ? (
                  <Button
                    onClick={connectBridge}
                    icon={<PhoneIcon size={16} />}
                  >
                    Connect phone bridge
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={disconnectBridge}
                    icon={<PhoneDisconnectIcon size={16} />}
                  >
                    Disconnect
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={!connected}
                  onClick={toggleMute}
                  icon={
                    isMuted ? (
                      <MicrophoneIcon size={16} />
                    ) : (
                      <MicrophoneSlashIcon size={16} />
                    )
                  }
                >
                  {isMuted ? "Unmute bridge" : "Mute bridge"}
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
                Phone call transcript
              </Text>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-auto pr-1">
              {transcript.length === 0 && !interimTranscript ? (
                <Surface className="rounded-xl p-4 ring ring-kumo-line">
                  <Text size="sm" variant="secondary">
                    Connect the bridge, call your Telnyx number, and speak to
                    the agent over the phone. You can also send a text turn once
                    connected.
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
                      {message.role === "user" ? "Caller" : "Assistant"}
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
                      Caller
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
                if (!value || !canSendText) return;
                phoneClientRef.current?.sendText(value);
                setText("");
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-full border border-kumo-line bg-kumo-surface px-4 py-2 text-kumo-default outline-none focus:border-kumo-accent disabled:opacity-60"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Send a text turn to the same agent..."
                aria-label="Text message"
                disabled={!canSendText}
              />
              <Button
                type="submit"
                disabled={!canSendText}
                icon={<PaperPlaneRightIcon size={16} />}
              >
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
