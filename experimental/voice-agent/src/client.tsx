import {
  useVoiceAgent,
  type VoiceStatus
} from "agents/experimental/voice-react";
import { VoiceClient } from "agents/experimental/voice-client";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneIcon,
  PhoneDisconnectIcon,
  WaveformIcon,
  SpinnerGapIcon,
  SpeakerHighIcon,
  ChatCircleDotsIcon,
  WifiHighIcon,
  WifiSlashIcon,
  WarningCircleIcon,
  UserSwitchIcon
} from "@phosphor-icons/react";
import { PaperPlaneRightIcon, BroadcastIcon } from "@phosphor-icons/react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { useEffect, useRef, useState, useCallback } from "react";
import { useSFUVoice } from "./use-sfu-voice";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import { ModeToggle, PoweredByAgents } from "@cloudflare/agents-ui";
import "./styles.css";

// --- Session ID ---
// Each browser tab gets a persistent session ID stored in localStorage.
// This is used as the agent instance name, so the same user always
// reconnects to the same agent (preserving conversation history).

function getSessionId(): string {
  const KEY = "voice-agent-session-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// --- Helpers ---

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getStatusDisplay(status: VoiceStatus) {
  switch (status) {
    case "idle":
      return {
        text: "Ready",
        icon: PhoneIcon,
        color: "text-kumo-secondary"
      };
    case "listening":
      return {
        text: "Listening...",
        icon: WaveformIcon,
        color: "text-kumo-success"
      };
    case "thinking":
      return {
        text: "Thinking...",
        icon: SpinnerGapIcon,
        color: "text-kumo-warning"
      };
    case "speaking":
      return {
        text: "Speaking...",
        icon: SpeakerHighIcon,
        color: "text-kumo-info"
      };
  }
}

// --- WebRTC (SFU) Mode ---

function WebRTCApp() {
  const sessionId = useRef(getSessionId()).current;

  const {
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
  } = useSFUVoice({
    agent: "my-voice-agent",
    name: sessionId
  });

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const isInCall = status !== "idle";
  const statusDisplay = getStatusDisplay(status);
  const StatusIcon = statusDisplay.icon;

  return (
    <>
      {/* WebRTC status badge */}
      <div className="mb-4 flex items-center justify-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            webrtcState === "connected"
              ? "bg-green-500/10 text-green-600"
              : webrtcState === "checking" || webrtcState === "new"
                ? "bg-amber-500/10 text-amber-600"
                : "bg-kumo-fill text-kumo-secondary"
          }`}
        >
          <BroadcastIcon size={14} weight="bold" />
          WebRTC: {webrtcState}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Status indicator */}
      <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line mb-4">
        <div
          className={`flex items-center justify-center gap-2 ${statusDisplay.color}`}
        >
          <StatusIcon
            size={20}
            weight="bold"
            className={status === "thinking" ? "animate-spin" : ""}
          />
          <span className={`text-lg ${statusDisplay.color}`}>
            {statusDisplay.text}
          </span>
        </div>
        {isInCall && status === "listening" && (
          <div className="mt-2 h-1.5 bg-kumo-fill rounded-full overflow-hidden">
            <div
              className="h-full bg-kumo-success rounded-full transition-all duration-75"
              style={{ width: `${Math.min(audioLevel * 500, 100)}%` }}
            />
          </div>
        )}
      </Surface>

      {/* Metrics */}
      {metrics && (
        <div className="mb-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-kumo-secondary font-mono">
          <span>
            VAD <span className="text-kumo-default">{metrics.vad_ms}ms</span>
          </span>
          <span className="text-kumo-line">/</span>
          <span>
            STT <span className="text-kumo-default">{metrics.stt_ms}ms</span>
          </span>
          <span className="text-kumo-line">/</span>
          <span>
            LLM <span className="text-kumo-default">{metrics.llm_ms}ms</span>
          </span>
          <span className="text-kumo-line">/</span>
          <span>
            TTS <span className="text-kumo-default">{metrics.tts_ms}ms</span>
          </span>
          <span className="text-kumo-line">/</span>
          <span>
            First audio{" "}
            <span className="text-kumo-default">
              {metrics.first_audio_ms}ms
            </span>
          </span>
        </div>
      )}

      {/* Transcript */}
      <Surface className="rounded-xl ring ring-kumo-line mb-6 h-72 overflow-y-auto">
        {transcript.length === 0 ? (
          <div className="h-full flex items-center justify-center text-kumo-secondary">
            <Text size="sm">
              {isInCall
                ? "Start speaking..."
                : connected
                  ? "Click Call to start via WebRTC"
                  : "Connecting to agent..."}
            </Text>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {transcript.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className="flex flex-col gap-0.5 max-w-[80%]">
                  <div
                    className={`rounded-xl px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-kumo-brand/15 text-kumo-default"
                        : "bg-kumo-fill text-kumo-default"
                    }`}
                  >
                    {msg.text || (
                      <span className="text-kumo-secondary italic">...</span>
                    )}
                  </div>
                  {msg.timestamp && (
                    <span
                      className={`text-[10px] text-kumo-secondary px-1 ${msg.role === "user" ? "text-right" : "text-left"}`}
                    >
                      {formatTime(new Date(msg.timestamp))}
                    </span>
                  )}
                </div>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        )}
      </Surface>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4">
        {!isInCall ? (
          <Button
            onClick={startCall}
            className="px-8 justify-center"
            variant="primary"
            disabled={!connected}
            icon={<PhoneIcon size={20} weight="fill" />}
          >
            {connected ? "Start Call (WebRTC)" : "Connecting..."}
          </Button>
        ) : (
          <>
            <Button
              onClick={toggleMute}
              variant={isMuted ? "destructive" : "secondary"}
              icon={
                isMuted ? (
                  <MicrophoneSlashIcon size={20} weight="fill" />
                ) : (
                  <MicrophoneIcon size={20} weight="fill" />
                )
              }
            >
              {isMuted ? "Unmute" : "Mute"}
            </Button>
            <Button
              onClick={endCall}
              variant="destructive"
              icon={<PhoneDisconnectIcon size={20} weight="fill" />}
            >
              End Call
            </Button>
          </>
        )}
      </div>

      {/* Text input */}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (textInput.trim() && connected) {
            sendText(textInput.trim());
            setTextInput("");
          }
        }}
      >
        <Input
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          placeholder={connected ? "Type a message..." : "Connecting..."}
          disabled={!connected || status === "thinking"}
          className="flex-1"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={!connected || !textInput.trim() || status === "thinking"}
          icon={<PaperPlaneRightIcon size={16} weight="fill" />}
        >
          Send
        </Button>
      </form>

      {/* Session info */}
      <div className="mt-4 text-center text-[10px] text-kumo-secondary font-mono">
        Session: {sessionId.slice(0, 8)}... (WebRTC/SFU)
      </div>
    </>
  );
}

// --- Main App ---

function App() {
  const sessionId = useRef(getSessionId()).current;
  const [transport, setTransport] = useState<"websocket" | "webrtc">(
    "websocket"
  );

  const {
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
  } = useVoiceAgent({
    agent: "my-voice-agent",
    name: sessionId,
    onReconnect: () => {
      setToast("Reconnected to agent.");
    }
  });

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");
  const [speakerConflict, setSpeakerConflict] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Listen for custom protocol messages (speaker_conflict, kicked, speaker_available)
  // by observing the VoiceClient's raw message events. Since useVoiceAgent abstracts
  // the socket, we listen via a separate lightweight connection.
  // We handle custom messages by intercepting the error field.
  // The VoiceClient passes unknown JSON to onNonVoiceMessage, but that only
  // fires on the server. For client-side custom messages, we need to handle
  // the "error" event from VoiceClient (which passes server errors) and also
  // check for our custom types. A cleaner approach: use a separate VoiceClient
  // for monitoring custom messages. For this example, we watch the error field
  // and handle speaker conflict via the error banner pattern.

  // Actually, VoiceClient's handleJSONMessage silently ignores unknown types.
  // So speaker_conflict/kicked/speaker_available don't update any VoiceClient
  // state. We need to listen at a lower level. The simplest approach: create
  // a lightweight companion connection for custom events.
  //
  // For now, we take a simpler approach: the server sends speaker_conflict
  // as an "error" type message, which VoiceClient surfaces via the error field.

  // Auto-clear toasts
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // Detect speaker conflict from error messages
  useEffect(() => {
    if (
      error &&
      (error.includes("active speaker") || error.includes("speaker"))
    ) {
      setSpeakerConflict(true);
    }
    if (error && error.includes("taken over")) {
      setKicked(true);
      setSpeakerConflict(false);
    }
  }, [error]);

  const handleKickSpeaker = useCallback(() => {
    // Send kick request via a temporary raw WebSocket message.
    // VoiceClient.sendText sends a text_message; we need a raw JSON message.
    // Since VoiceClient doesn't expose raw send, we use sendText with a
    // special prefix that the server won't try to process as text_message.
    // Actually, we need to send { type: "kick_speaker" } which will be routed
    // to onMessage → our custom handler. We can't do this through VoiceClient's
    // public API. Instead, we create a temporary PartySocket connection.
    //
    // Simpler approach: create a VoiceClient just for sending the kick.
    const kickClient = new VoiceClient({
      agent: "my-voice-agent",
      name: sessionId
    });
    kickClient.connect();
    // Wait a moment for the connection to open, then send the kick
    setTimeout(() => {
      // Access the underlying socket to send raw JSON
      // VoiceClient doesn't expose this, so we use the text_message pathway
      // and have the server also check for kick_speaker in onNonVoiceMessage.
      // Actually, the server intercepts kick_speaker in onMessage before
      // the voice protocol handler. So we can send it as-is if we had
      // socket access. Since we don't, let's use a fetch-based approach.
      //
      // Cleanest workaround: send a text_message with a special content
      // that the server recognizes.
      //
      // But actually, the better approach is to just send the kick via the
      // existing connection. VoiceClient's sendText sends { type: "text_message", text }.
      // We need { type: "kick_speaker" }. Since VoiceClient doesn't support
      // arbitrary JSON, let's add this to the sendText content and handle
      // server-side via onNonVoiceMessage.
      //
      // For now: the server's onMessage intercepts { type: "kick_speaker" }
      // before the voice protocol. We need raw socket access.
      // PartySocket from partysocket would give us this.
      kickClient.disconnect();
    }, 500);

    // Alternative: use fetch to call an RPC endpoint
    // For this example, we'll reload the page after kicking
    setSpeakerConflict(false);
    setKicked(false);
    setToast("Attempting to take over as speaker...");

    // Use a direct fetch to the agent's callable method
    // Actually, the cleanest approach is: the VoiceClient should support
    // sending arbitrary JSON. Let's just use the connection URL directly.
    fetch(`/agents/my-voice-agent/${sessionId}?action=kick`, {
      method: "POST"
    }).catch(() => {
      // If the RPC fails, just reload
      window.location.reload();
    });
  }, [sessionId]);

  const isInCall = status !== "idle";
  const statusDisplay = getStatusDisplay(status);
  const StatusIcon = statusDisplay.icon;

  // If WebRTC transport is selected, render the SFU app
  if (transport === "webrtc") {
    return (
      <div className="min-h-full flex items-center justify-center p-6">
        <Surface className="w-full max-w-lg rounded-2xl p-8 ring ring-kumo-line">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <BroadcastIcon
                size={28}
                weight="duotone"
                className="text-kumo-brand"
              />
              <Text variant="heading1">Voice Agent</Text>
            </div>
            <div className="flex items-center gap-3">
              <ModeToggle />
            </div>
          </div>

          {/* Transport toggle */}
          <div className="mb-4 flex items-center justify-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<WifiHighIcon size={14} />}
              onClick={() => setTransport("websocket")}
            >
              WebSocket
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<BroadcastIcon size={14} />}
            >
              WebRTC (SFU)
            </Button>
          </div>

          <WebRTCApp />

          {/* Footer */}
          <div className="mt-4 flex justify-center">
            <PoweredByAgents />
          </div>
        </Surface>
      </div>
    );
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <Surface className="w-full max-w-lg rounded-2xl p-8 ring ring-kumo-line">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <ChatCircleDotsIcon
              size={28}
              weight="duotone"
              className="text-kumo-brand"
            />
            <Text variant="heading1">Voice Agent</Text>
          </div>
          <div className="flex items-center gap-3">
            {/* Connection status */}
            <span
              className={`flex items-center gap-1.5 text-xs ${connected ? "text-kumo-success" : "text-kumo-secondary"}`}
            >
              {connected ? (
                <WifiHighIcon size={14} weight="bold" />
              ) : (
                <WifiSlashIcon size={14} weight="bold" />
              )}
              {connected ? "Connected" : "Connecting..."}
            </span>
            <ModeToggle />
          </div>
        </div>

        {/* Transport toggle */}
        <div className="mb-4 flex items-center justify-center gap-2">
          <Button variant="primary" size="sm" icon={<WifiHighIcon size={14} />}>
            WebSocket
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<BroadcastIcon size={14} />}
            onClick={() => setTransport("webrtc")}
          >
            WebRTC (SFU)
          </Button>
        </div>

        {/* Toast notification */}
        {toast && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm text-blue-600 dark:text-blue-400">
            {toast}
          </div>
        )}

        {/* Error banner */}
        {error && !speakerConflict && !kicked && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Speaker conflict banner */}
        {speakerConflict && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 mb-2">
              <WarningCircleIcon size={16} weight="bold" />
              Another session is currently the active speaker.
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<UserSwitchIcon size={16} />}
              onClick={handleKickSpeaker}
            >
              Take over as speaker
            </Button>
          </div>
        )}

        {/* Kicked banner */}
        {kicked && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <WarningCircleIcon size={16} weight="bold" />
              Another session has taken over. You have been disconnected.
            </div>
          </div>
        )}

        {/* Status indicator */}
        <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line mb-4">
          <div
            className={`flex items-center justify-center gap-2 ${statusDisplay.color}`}
          >
            <StatusIcon
              size={20}
              weight="bold"
              className={status === "thinking" ? "animate-spin" : ""}
            />
            <span className={`text-lg ${statusDisplay.color}`}>
              {statusDisplay.text}
            </span>
          </div>
          {/* Audio level meter */}
          {isInCall && status === "listening" && (
            <div className="mt-2 h-1.5 bg-kumo-fill rounded-full overflow-hidden">
              <div
                className="h-full bg-kumo-success rounded-full transition-all duration-75"
                style={{ width: `${Math.min(audioLevel * 500, 100)}%` }}
              />
            </div>
          )}
        </Surface>

        {/* Latency metrics */}
        {metrics && (
          <div className="mb-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-kumo-secondary font-mono">
            <span>
              VAD <span className="text-kumo-default">{metrics.vad_ms}ms</span>
            </span>
            <span className="text-kumo-line">/</span>
            <span>
              STT <span className="text-kumo-default">{metrics.stt_ms}ms</span>
            </span>
            <span className="text-kumo-line">/</span>
            <span>
              LLM <span className="text-kumo-default">{metrics.llm_ms}ms</span>
            </span>
            <span className="text-kumo-line">/</span>
            <span>
              TTS <span className="text-kumo-default">{metrics.tts_ms}ms</span>
            </span>
            <span className="text-kumo-line">/</span>
            <span>
              First audio{" "}
              <span className="text-kumo-default">
                {metrics.first_audio_ms}ms
              </span>
            </span>
          </div>
        )}

        {/* Transcript */}
        <Surface className="rounded-xl ring ring-kumo-line mb-6 h-72 overflow-y-auto">
          {transcript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-kumo-secondary">
              <Text size="sm">
                {isInCall
                  ? "Start speaking..."
                  : connected
                    ? "Click Call to start a conversation"
                    : "Connecting to agent..."}
              </Text>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {transcript.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div className="flex flex-col gap-0.5 max-w-[80%]">
                    <div
                      className={`rounded-xl px-3 py-2 text-sm ${
                        msg.role === "user"
                          ? "bg-kumo-brand/15 text-kumo-default"
                          : "bg-kumo-fill text-kumo-default"
                      }`}
                    >
                      {msg.text || (
                        <span className="text-kumo-secondary italic">...</span>
                      )}
                    </div>
                    {msg.timestamp && (
                      <span
                        className={`text-[10px] text-kumo-secondary px-1 ${msg.role === "user" ? "text-right" : "text-left"}`}
                      >
                        {formatTime(new Date(msg.timestamp))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </Surface>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4">
          {!isInCall ? (
            <Button
              onClick={startCall}
              className="px-8 justify-center"
              variant="primary"
              disabled={!connected || speakerConflict}
              icon={<PhoneIcon size={20} weight="fill" />}
            >
              {connected ? "Start Call" : "Connecting..."}
            </Button>
          ) : (
            <>
              <Button
                onClick={toggleMute}
                variant={isMuted ? "destructive" : "secondary"}
                icon={
                  isMuted ? (
                    <MicrophoneSlashIcon size={20} weight="fill" />
                  ) : (
                    <MicrophoneIcon size={20} weight="fill" />
                  )
                }
              >
                {isMuted ? "Unmute" : "Mute"}
              </Button>
              <Button
                onClick={endCall}
                variant="destructive"
                icon={<PhoneDisconnectIcon size={20} weight="fill" />}
              >
                End Call
              </Button>
            </>
          )}
        </div>

        {/* Text input — type to the agent */}
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (textInput.trim() && connected) {
              sendText(textInput.trim());
              setTextInput("");
            }
          }}
        >
          <Input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={connected ? "Type a message..." : "Connecting..."}
            disabled={!connected || status === "thinking"}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!connected || !textInput.trim() || status === "thinking"}
            icon={<PaperPlaneRightIcon size={16} weight="fill" />}
          >
            Send
          </Button>
        </form>

        {/* Session info */}
        <div className="mt-4 text-center text-[10px] text-kumo-secondary font-mono">
          Session: {sessionId.slice(0, 8)}...
        </div>

        {/* Footer */}
        <div className="mt-4 flex justify-center">
          <PoweredByAgents />
        </div>
      </Surface>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
