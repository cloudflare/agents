import { useAgent } from "agents/react";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneIcon,
  PhoneDisconnectIcon,
  WaveformIcon,
  SpinnerGapIcon,
  SpeakerHighIcon,
  ChatCircleDotsIcon
} from "@phosphor-icons/react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { VoiceAgentState } from "./server";
import "./styles.css";

type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

// --- Audio capture & playback helpers ---

const SILENCE_THRESHOLD = 0.01; // RMS threshold for silence detection
const SILENCE_DURATION_MS = 1500; // how long silence before end-of-speech

/**
 * AudioWorklet processor source code.
 * Captures audio, downsamples to 16kHz mono, and posts PCM chunks.
 */
const WORKLET_PROCESSOR = `
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sampleRate = sampleRate; // global in AudioWorkletGlobalScope
    this.targetRate = 16000;
    this.ratio = this.sampleRate / this.targetRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // mono or first channel

    // Simple downsampling by picking nearest sample
    for (let i = 0; i < channelData.length; i += this.ratio) {
      const idx = Math.floor(i);
      if (idx < channelData.length) {
        this.buffer.push(channelData[idx]);
      }
    }

    // Send chunks periodically (~100ms worth at 16kHz = 1600 samples)
    if (this.buffer.length >= 1600) {
      const chunk = new Float32Array(this.buffer);
      this.port.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
      this.buffer = [];
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
`;

function floatTo16BitPCM(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// --- Main App ---

function App() {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  // Refs for audio pipeline
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpeakingRef = useRef(false);
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<VoiceAgentState>({
    agent: "voice-agent",
    onOpen: () => {
      console.log("[Client] WebSocket connected to agent");
    },
    onClose: () => {
      console.log("[Client] WebSocket disconnected from agent");
    },
    onError: () => {
      console.error("[Client] WebSocket error");
    },
    onMessage: (event: MessageEvent) => {
      if (typeof event.data === "string") {
        console.log(
          "[Client] Received text message:",
          event.data.slice(0, 200)
        );
        handleJSONMessage(event.data);
      } else if (event.data instanceof Blob) {
        console.log(
          `[Client] Received Blob: ${(event.data.size / 1024).toFixed(1)} KB`
        );
        event.data.arrayBuffer().then((buffer) => {
          console.log(
            `[Client] Blob → ArrayBuffer: ${(buffer.byteLength / 1024).toFixed(1)} KB, queueing for playback`
          );
          playbackQueueRef.current.push(buffer);
          processPlaybackQueue();
        });
      } else if (event.data instanceof ArrayBuffer) {
        console.log(
          `[Client] Received ArrayBuffer: ${(event.data.byteLength / 1024).toFixed(1)} KB, queueing for playback`
        );
        playbackQueueRef.current.push(event.data);
        processPlaybackQueue();
      } else {
        console.log(
          "[Client] Received unknown message type:",
          typeof event.data
        );
      }
    }
  });

  const handleJSONMessage = useCallback((data: string) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "status":
          console.log(`[Client] Status update: ${msg.status}`);
          setStatus(msg.status);
          break;
        case "transcript":
          console.log(
            `[Client] Transcript (${msg.role}): "${msg.text.slice(0, 100)}"`
          );
          setTranscript((prev) => [
            ...prev,
            { role: msg.role, text: msg.text }
          ]);
          break;
        case "error":
          console.error("[Client] Agent error:", msg.message);
          break;
        default:
          console.log(`[Client] Unknown message type: ${msg.type}`);
      }
    } catch {
      // ignore non-JSON messages (state sync etc.)
      console.log("[Client] Non-JSON message (state sync?), ignoring");
    }
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // --- Audio playback ---

  const playAudio = useCallback(async (mp3Data: ArrayBuffer) => {
    try {
      const ctx =
        audioContextRef.current || new AudioContext({ sampleRate: 48000 });
      if (!audioContextRef.current) {
        console.log(
          `[Client] Created new AudioContext, state: ${ctx.state}, sampleRate: ${ctx.sampleRate}`
        );
        audioContextRef.current = ctx;
      }

      // Resume context if suspended (browser autoplay policy)
      if (ctx.state === "suspended") {
        console.log(`[Client] AudioContext suspended, resuming...`);
        await ctx.resume();
        console.log(`[Client] AudioContext resumed: ${ctx.state}`);
      }

      console.log(
        `[Client] Decoding audio data: ${(mp3Data.byteLength / 1024).toFixed(1)} KB`
      );
      const audioBuffer = await ctx.decodeAudioData(mp3Data.slice(0));
      console.log(
        `[Client] Decoded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz`
      );

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      return new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
        console.log(`[Client] Audio playback started`);
      });
    } catch (error) {
      console.error("[Client] Audio playback error:", error);
    }
  }, []);

  const processPlaybackQueue = useCallback(async () => {
    if (isPlayingRef.current || playbackQueueRef.current.length === 0) {
      console.log(
        `[Client] Playback queue: playing=${isPlayingRef.current}, queue=${playbackQueueRef.current.length}`
      );
      return;
    }
    isPlayingRef.current = true;
    console.log(
      `[Client] Starting playback, ${playbackQueueRef.current.length} items in queue`
    );

    while (playbackQueueRef.current.length > 0) {
      const audioData = playbackQueueRef.current.shift()!;
      console.log(
        `[Client] Playing audio: ${(audioData.byteLength / 1024).toFixed(1)} KB`
      );
      await playAudio(audioData);
      console.log(`[Client] Audio playback finished`);
    }

    isPlayingRef.current = false;
    console.log(`[Client] Playback queue drained`);
  }, [playAudio]);

  // --- Mic capture ---

  const startMic = useCallback(async () => {
    console.log("[Client] Starting mic capture...");
    try {
      console.log("[Client] Requesting getUserMedia...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      streamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0];
      const settings = audioTrack.getSettings();
      console.log(
        `[Client] Got mic stream: ${audioTrack.label}, sampleRate=${settings.sampleRate}, channels=${settings.channelCount}`
      );

      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      console.log(
        `[Client] AudioContext created: sampleRate=${ctx.sampleRate}, state=${ctx.state}`
      );

      // Create worklet from blob URL
      console.log("[Client] Loading AudioWorklet...");
      const blob = new Blob([WORKLET_PROCESSOR], {
        type: "application/javascript"
      });
      const workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      console.log("[Client] AudioWorklet loaded");

      const source = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, "audio-capture-processor");
      workletNodeRef.current = workletNode;

      let chunkCount = 0;
      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "audio" && !isMuted) {
          const samples = event.data.samples as Float32Array;
          const rms = computeRMS(samples);
          setAudioLevel(rms);

          chunkCount++;
          if (chunkCount % 50 === 1) {
            console.log(
              `[Client] Audio chunk #${chunkCount}: ${samples.length} samples, RMS=${rms.toFixed(4)}, speaking=${isSpeakingRef.current}`
            );
          }

          // Send PCM to agent
          const pcm = floatTo16BitPCM(samples);
          if (agent.readyState === WebSocket.OPEN) {
            agent.send(pcm);
          } else {
            if (chunkCount % 50 === 1) {
              console.log(
                `[Client] WebSocket not open (state=${agent.readyState}), dropping audio`
              );
            }
          }

          // Silence detection
          if (rms > SILENCE_THRESHOLD) {
            if (!isSpeakingRef.current) {
              console.log(
                `[Client] Speech started (RMS=${rms.toFixed(4)} > ${SILENCE_THRESHOLD})`
              );
            }
            isSpeakingRef.current = true;
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          } else if (isSpeakingRef.current) {
            if (!silenceTimerRef.current) {
              console.log(
                `[Client] Silence detected, starting ${SILENCE_DURATION_MS}ms timer...`
              );
              silenceTimerRef.current = setTimeout(() => {
                // Silence detected — end of speech
                console.log(
                  `[Client] End of speech! Sending end_of_speech to agent`
                );
                isSpeakingRef.current = false;
                silenceTimerRef.current = null;
                if (agent.readyState === WebSocket.OPEN) {
                  agent.send(JSON.stringify({ type: "end_of_speech" }));
                }
              }, SILENCE_DURATION_MS);
            }
          }
        }
      };

      source.connect(workletNode);
      workletNode.connect(ctx.destination); // needed for worklet to process
      console.log("[Client] Mic pipeline connected and running");
    } catch (error) {
      console.error("[Client] Mic error:", error);
    }
  }, [agent, isMuted]);

  const stopMic = useCallback(() => {
    console.log("[Client] Stopping mic capture");
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    isSpeakingRef.current = false;
    setAudioLevel(0);
    console.log("[Client] Mic stopped");
  }, []);

  // --- Call controls ---

  const handleStartCall = useCallback(async () => {
    console.log(
      `[Client] Start Call clicked, socket state: ${agent.readyState}, OPEN=${WebSocket.OPEN}`
    );
    if (agent.readyState === WebSocket.OPEN) {
      console.log("[Client] Sending start_call to agent");
      agent.send(JSON.stringify({ type: "start_call" }));
      await startMic();
    } else {
      console.error(
        `[Client] Cannot start call: WebSocket not open (state=${agent.readyState})`
      );
    }
  }, [agent, startMic]);

  const handleEndCall = useCallback(() => {
    console.log("[Client] End Call clicked");
    if (agent.readyState === WebSocket.OPEN) {
      agent.send(JSON.stringify({ type: "end_call" }));
    }
    stopMic();
    setStatus("idle");
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
  }, [agent, stopMic]);

  const toggleMute = useCallback(() => {
    console.log(`[Client] Toggle mute: ${isMuted} → ${!isMuted}`);
    setIsMuted((prev) => !prev);
  }, [isMuted]);

  const isInCall = status !== "idle";

  const getStatusDisplay = () => {
    switch (status) {
      case "idle":
        return { text: "Ready", icon: PhoneIcon, color: "text-kumo-secondary" };
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
  };

  const statusDisplay = getStatusDisplay();
  const StatusIcon = statusDisplay.icon;

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <Surface className="w-full max-w-lg rounded-2xl p-8 ring ring-kumo-line">
        {/* Header */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <ChatCircleDotsIcon
            size={32}
            weight="duotone"
            className="text-kumo-brand"
          />
          <Text variant="heading1">Voice Agent</Text>
        </div>

        {/* Status indicator */}
        <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line mb-6">
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

        {/* Transcript */}
        <Surface className="rounded-xl ring ring-kumo-line mb-6 h-72 overflow-y-auto">
          {transcript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-kumo-secondary">
              <Text size="sm">
                {isInCall
                  ? "Start speaking..."
                  : "Click Call to start a conversation"}
              </Text>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {transcript.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-kumo-brand/15 text-kumo-default"
                        : "bg-kumo-fill text-kumo-default"
                    }`}
                  >
                    {msg.text}
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
              onClick={handleStartCall}
              className="px-8 justify-center"
              variant="primary"
              icon={<PhoneIcon size={20} weight="fill" />}
            >
              Start Call
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
                onClick={handleEndCall}
                variant="destructive"
                icon={<PhoneDisconnectIcon size={20} weight="fill" />}
              >
                End Call
              </Button>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <span className="text-xs text-kumo-secondary">
            Voice Agent demo — audio processed entirely inside a Durable Object
          </span>
        </div>
      </Surface>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
