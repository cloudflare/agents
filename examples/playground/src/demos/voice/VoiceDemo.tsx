import { useVoiceAgent, type VoiceStatus } from "agents/voice-react";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneIcon,
  PhoneDisconnectIcon,
  WaveformIcon,
  SpinnerGapIcon,
  SpeakerHighIcon,
  PaperPlaneRightIcon
} from "@phosphor-icons/react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { DemoWrapper } from "../../layout/DemoWrapper";
import { ConnectionStatus } from "../../components/ConnectionStatus";

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

export function VoiceDemo() {
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
  } = useVoiceAgent({ agent: "playground-voice-agent" });

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const isInCall = status !== "idle";
  const statusDisplay = getStatusDisplay(status);
  const StatusIcon = statusDisplay.icon;

  return (
    <DemoWrapper
      title="Voice Chat"
      description="Real-time voice conversation with STT, LLM, and streaming TTS. Speak to the agent and it responds with natural speech."
      statusIndicator={
        <ConnectionStatus status={connected ? "connected" : "connecting"} />
      }
    >
      <div className="max-w-lg mx-auto space-y-4">
        {/* Error banner */}
        {error && (
          <div className="px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Status indicator */}
        <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line">
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

        {/* Latency metrics */}
        {metrics && (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-kumo-secondary font-mono">
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
        <Surface className="rounded-xl ring ring-kumo-line h-72 overflow-y-auto">
          {transcript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-kumo-secondary">
              <Text size="sm">
                {isInCall
                  ? "Start speaking..."
                  : connected
                    ? "Click Start Call to begin"
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
          className="flex gap-2"
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
      </div>
    </DemoWrapper>
  );
}
