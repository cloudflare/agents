import { useState, useEffect, useRef, useCallback } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import type { VoiceChatAgent, VoiceChatState } from "../agents/voice-chat";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  CaretDownIcon,
  MicrophoneIcon,
  TrashIcon,
  StopCircleIcon,
  GearIcon,
  BrainIcon,
  SpeakerHighIcon,
  SpinnerIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

interface Voice {
  voiceId: string;
  name: string;
}

function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(
      -32768,
      Math.min(32767, Math.round(float32[i] * 32767))
    );
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function ReplayButton({ onReplay }: { onReplay: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      aria-label="Replay"
      disabled={loading}
      icon={
        loading ? (
          <SpinnerIcon size={14} className="animate-spin" />
        ) : (
          <SpeakerHighIcon size={14} />
        )
      }
      onClick={async () => {
        setLoading(true);
        try {
          await onReplay();
        } finally {
          setLoading(false);
        }
      }}
    />
  );
}

export function VoiceChatTab() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [showVoices, setShowVoices] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [committedText, setCommittedText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playingAudioRef = useRef<HTMLAudioElement | null>(null);

  const playAudio = useCallback((dataUri: string) => {
    if (playingAudioRef.current) {
      playingAudioRef.current.pause();
      playingAudioRef.current.currentTime = 0;
    }
    const audio = new Audio(dataUri);
    playingAudioRef.current = audio;
    setSpeaking(true);
    audio.onended = () => {
      playingAudioRef.current = null;
      setSpeaking(false);
    };
    audio.onerror = () => {
      playingAudioRef.current = null;
      setSpeaking(false);
    };
    audio.play();
  }, []);

  const stopAudio = useCallback(() => {
    if (playingAudioRef.current) {
      playingAudioRef.current.pause();
      playingAudioRef.current.currentTime = 0;
      playingAudioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const agent = useAgent<VoiceChatAgent, VoiceChatState>({
    agent: "VoiceChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onMessage: useCallback((event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === "stt-transcript") {
          if (data.partial) {
            setPartialTranscript(data.text);
          } else {
            setCommittedText((prev) =>
              prev ? `${prev} ${data.text}` : data.text
            );
            setPartialTranscript("");
          }
        }
      } catch {
        // not our message
      }
    }, [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming" || status === "submitted";
  const currentVoiceId = agent.state?.voiceId ?? "JBFqnCBsd6RMkjVDRZzb";

  const prevStreamingRef = useRef(false);
  const lastSpokenIdRef = useRef<string>("");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && !recording && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming, recording]);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === "assistant" && last.id !== lastSpokenIdRef.current) {
        const text = last.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ")
          .trim();
        if (text) {
          lastSpokenIdRef.current = last.id;
          agent.call("speak", [text]).then((dataUri) => {
            playAudio(dataUri as string);
          });
        }
      }
    }
  }, [isStreaming, messages, agent, playAudio]);

  const loadVoices = useCallback(async () => {
    if (voices.length > 0) {
      setShowVoices(!showVoices);
      return;
    }
    try {
      const result = await agent.call("listVoices", []);
      setVoices(result as Voice[]);
      setShowVoices(true);
    } catch (e) {
      console.error("Failed to load voices:", e);
    }
  }, [agent, voices.length, showVoices]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // 4096 samples at 16kHz = ~256ms per chunk
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const samples = e.inputBuffer.getChannelData(0);
        const base64 = float32ToInt16Base64(samples);
        agent.send(JSON.stringify({ type: "audio-chunk", data: base64 }));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      await agent.call("startTranscription", []);
      setRecording(true);
      setCommittedText("");
      setPartialTranscript("");
    } catch (e) {
      console.error("Microphone access denied:", e);
    }
  }, [agent]);

  const stopRecording = useCallback(async () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();

    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;

    setRecording(false);

    try {
      await agent.call("stopTranscription", []);
    } catch (e) {
      console.error("Stop transcription error:", e);
    }

    // Move accumulated transcript into the input field
    setCommittedText((text) => {
      setPartialTranscript((partial) => {
        const full = [text, partial].filter(Boolean).join(" ").trim();
        if (full) {
          setInput((prev) => (prev ? `${prev} ${full}` : full));
        }
        return "";
      });
      return "";
    });
  }, [agent]);

  const toggleRecording = useCallback(() => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [recording, startRecording, stopRecording]);

  const liveText = [committedText, partialTranscript].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-kumo-line bg-kumo-base">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <span className="text-xs text-kumo-subtle">
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Button
                variant="secondary"
                size="sm"
                icon={<MicrophoneIcon size={14} />}
                onClick={loadVoices}
              >
                {voices.find((v) => v.voiceId === currentVoiceId)?.name ??
                  "Voice"}
                <CaretDownIcon size={12} className="ml-1" />
              </Button>
              {showVoices && voices.length > 0 && (
                <div className="absolute right-0 top-full mt-1 w-64 z-50">
                  <Surface className="rounded-lg ring ring-kumo-line shadow-lg p-2 max-h-60 overflow-y-auto">
                    {voices.map((v) => (
                      <button
                        key={v.voiceId}
                        className={`w-full text-left px-3 py-2 rounded-md text-sm hover:bg-kumo-control transition-colors ${
                          v.voiceId === currentVoiceId
                            ? "bg-kumo-control font-medium"
                            : ""
                        }`}
                        onClick={() => {
                          agent.call("setVoice", [v.voiceId]);
                          setShowVoices(false);
                        }}
                      >
                        {v.name}
                        {v.voiceId === currentVoiceId && (
                          <Badge variant="primary" className="ml-2">
                            Active
                          </Badge>
                        )}
                      </button>
                    ))}
                  </Surface>
                </div>
              )}
            </div>
            {speaking && (
              <Button
                variant="destructive"
                size="sm"
                icon={<StopCircleIcon size={14} />}
                onClick={stopAudio}
              >
                Stop
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<TrashIcon size={14} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-4">
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Voice Chat"
              contents={
                <div className="flex flex-wrap justify-center gap-2 mt-2">
                  {[
                    "Tell me a joke",
                    "Explain quantum computing simply",
                    "Write a haiku about the ocean"
                  ].map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      disabled={isStreaming}
                      onClick={() =>
                        sendMessage({
                          role: "user",
                          parts: [{ type: "text", text: prompt }]
                        })
                      }
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {/* Tool parts */}
                {message.parts.filter(isToolUIPart).map((part) => {
                  const toolName = getToolName(part);
                  return (
                    <div key={part.toolCallId} className="flex justify-start">
                      <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                        <div className="flex items-center gap-2 mb-1">
                          <GearIcon
                            size={14}
                            className={
                              part.state === "output-available"
                                ? "text-kumo-inactive"
                                : "text-kumo-inactive animate-spin"
                            }
                          />
                          <Text size="xs" variant="secondary" bold>
                            {toolName}
                          </Text>
                          <Badge variant="secondary">
                            {part.state === "output-available"
                              ? "Done"
                              : "Running"}
                          </Badge>
                        </div>
                        {part.state === "output-available" && (
                          <pre className="text-xs text-kumo-subtle font-mono whitespace-pre-wrap max-h-32 overflow-auto">
                            {JSON.stringify(part.output, null, 2)}
                          </pre>
                        )}
                      </Surface>
                    </div>
                  );
                })}

                {/* Reasoning parts */}
                {message.parts
                  .filter(
                    (p) =>
                      p.type === "reasoning" &&
                      (p as { text?: string }).text?.trim()
                  )
                  .map((part, i) => {
                    const reasoning = part as {
                      type: "reasoning";
                      text: string;
                      state?: "streaming" | "done";
                    };
                    const isDone = reasoning.state === "done" || !isStreaming;
                    return (
                      <div
                        key={`reason-${message.id}-${i}`}
                        className="flex justify-start"
                      >
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {reasoning.text}
                          </pre>
                        </details>
                      </div>
                    );
                  })}

                {/* Text parts */}
                {message.parts
                  .filter((p) => p.type === "text")
                  .map((part, i) => {
                    const text = (part as { text: string }).text;
                    if (!text) return null;

                    if (isUser) {
                      return (
                        <div
                          key={`${message.id}-${i}`}
                          className="flex justify-end"
                        >
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse">
                            {text}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={`${message.id}-${i}`}
                        className="flex justify-start gap-2 items-end"
                      >
                        <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {text}
                          </Streamdown>
                        </div>
                        {!isStreaming && text.length > 0 && (
                          <ReplayButton
                            onReplay={async () => {
                              const uri = (await agent.call("speak", [
                                text
                              ])) as string;
                              playAudio(uri);
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Live transcript preview */}
      {recording && liveText && (
        <div className="px-5 pb-2">
          <div className="max-w-3xl mx-auto">
            <div className="px-4 py-2 rounded-lg bg-kumo-control text-sm text-kumo-default italic">
              {liveText}
              <span className="animate-pulse">|</span>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <Button
              type="button"
              variant={recording ? "destructive" : "ghost"}
              shape="square"
              aria-label={recording ? "Stop recording" : "Record audio"}
              icon={
                <MicrophoneIcon
                  size={18}
                  weight={recording ? "fill" : "regular"}
                />
              }
              onClick={toggleRecording}
              disabled={!connected || isStreaming}
              className="mb-0.5"
            />
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder={
                recording
                  ? "Listening... tap mic to stop"
                  : "Type or tap the mic to speak..."
              }
              disabled={!connected || isStreaming || recording}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
