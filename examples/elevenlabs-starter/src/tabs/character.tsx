import { useState, useEffect, useRef, useCallback } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import type {
  CharacterAgent,
  CharacterState,
  VoicePreview
} from "../agents/character";
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
  UserCircleIcon,
  MagicWandIcon,
  PlayIcon,
  PauseIcon,
  CheckIcon,
  ArrowCounterClockwiseIcon,
  TrashIcon,
  SpinnerIcon,
  SpeakerHighIcon,
  GearIcon,
  BrainIcon,
  CaretDownIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { SpeakButton } from "../components/audio-player";

type DesignStep =
  | "idle"
  | "generating-prompt"
  | "generating-voices"
  | "previewing"
  | "saving"
  | "ready";

function VoicePreviewCard({
  preview,
  selected,
  onSelect
}: {
  preview: VoicePreview;
  selected: boolean;
  onSelect: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = useCallback(() => {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }
    const mimeType = preview.mediaType || "audio/mpeg";
    const src = preview.audioBase64.startsWith("data:")
      ? preview.audioBase64
      : `data:${mimeType};base64,${preview.audioBase64}`;
    const audio = new Audio(src);
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.play();
    setPlaying(true);
  }, [playing, preview.audioBase64, preview.mediaType]);

  return (
    <Surface
      className={`p-4 rounded-xl cursor-pointer transition-all ${
        selected
          ? "ring-2 ring-kumo-brand"
          : "ring ring-kumo-line hover:ring-kumo-accent"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {selected && (
            <CheckIcon size={16} className="text-kumo-brand" weight="bold" />
          )}
          <Text size="sm" bold>
            Voice {preview.generatedVoiceId.slice(0, 6)}
          </Text>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Play voice preview"
          icon={playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
        />
      </div>
    </Surface>
  );
}

type AgentHandle = ReturnType<typeof useAgent<CharacterAgent, CharacterState>>;

function DesignPhase({
  agent,
  onComplete
}: {
  agent: AgentHandle;
  onComplete: () => void;
}) {
  const [personality, setPersonality] = useState("");
  const [voiceDescription, setVoiceDescription] = useState("");
  const [name, setName] = useState("");
  const [step, setStep] = useState<DesignStep>("idle");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [previews, setPreviews] = useState<VoicePreview[]>([]);
  const [selectedPreview, setSelectedPreview] = useState<string>("");

  const generate = useCallback(async () => {
    if (!personality.trim() || !voiceDescription.trim()) return;

    setStep("generating-prompt");
    try {
      const prompt = (await agent.call("generateSystemPrompt", [
        personality
      ])) as string;
      setSystemPrompt(prompt);

      setStep("generating-voices");
      const voicePreviews = (await agent.call("designVoice", [
        voiceDescription
      ])) as VoicePreview[];
      setPreviews(voicePreviews);
      if (voicePreviews.length > 0) {
        setSelectedPreview(voicePreviews[0].generatedVoiceId);
      }
      setStep("previewing");
    } catch (e) {
      console.error("Design failed:", e);
      setStep("idle");
    }
  }, [personality, voiceDescription, agent]);

  const save = useCallback(async () => {
    if (!selectedPreview || !name.trim()) return;
    setStep("saving");
    try {
      await agent.call("saveCharacter", [
        name,
        personality,
        systemPrompt,
        voiceDescription,
        selectedPreview
      ]);
      setStep("ready");
      onComplete();
    } catch (e) {
      console.error("Save failed:", e);
      setStep("previewing");
    }
  }, [
    selectedPreview,
    name,
    personality,
    systemPrompt,
    voiceDescription,
    agent,
    onComplete
  ]);

  const isGenerating =
    step === "generating-prompt" || step === "generating-voices";

  return (
    <div className="max-w-2xl mx-auto px-5 py-6 space-y-6 h-full overflow-y-auto">
      <Surface className="p-5 rounded-xl ring ring-kumo-line space-y-4">
        <div className="flex items-center gap-2">
          <UserCircleIcon size={20} className="text-kumo-accent" />
          <Text size="sm" bold>
            Design Your Character
          </Text>
        </div>

        <div className="space-y-3">
          <div>
            <span className="text-xs font-medium text-kumo-subtle block mb-1">
              Personality
            </span>
            <InputArea
              value={personality}
              onValueChange={setPersonality}
              placeholder="A grumpy Victorian detective who speaks in riddles and loves tea..."
              rows={3}
              disabled={
                isGenerating || step === "previewing" || step === "saving"
              }
              className="w-full"
            />
          </div>
          <div>
            <span className="text-xs font-medium text-kumo-subtle block mb-1">
              Voice Description
            </span>
            <InputArea
              value={voiceDescription}
              onValueChange={setVoiceDescription}
              placeholder="A deep, gravelly British voice with a hint of weariness..."
              rows={2}
              disabled={
                isGenerating || step === "previewing" || step === "saving"
              }
              className="w-full"
            />
          </div>
          <Button
            variant="primary"
            icon={
              isGenerating ? (
                <SpinnerIcon size={16} className="animate-spin" />
              ) : (
                <MagicWandIcon size={16} />
              )
            }
            disabled={
              !personality.trim() ||
              !voiceDescription.trim() ||
              isGenerating ||
              step === "saving"
            }
            onClick={generate}
          >
            {step === "generating-prompt"
              ? "Crafting personality..."
              : step === "generating-voices"
                ? "Designing voice..."
                : "Design Character"}
          </Button>
          <div className="flex flex-wrap gap-2">
            {(
              [
                {
                  label: "Pirate Captain",
                  personality:
                    "A boisterous pirate captain who peppers every sentence with nautical metaphors and loves telling tall tales about treasure",
                  voice:
                    "A hearty, booming male voice with a rough edge and a hint of mischief"
                },
                {
                  label: "Noir Detective",
                  personality:
                    "A world-weary 1940s detective who narrates everything like a film noir monologue and is deeply cynical about human nature",
                  voice:
                    "A low, gravelly American voice with a slow, deliberate cadence"
                },
                {
                  label: "Fairy Guide",
                  personality:
                    "An enthusiastic woodland fairy who speaks in riddles, giggles often, and knows everything about mushrooms and moonlight",
                  voice:
                    "A light, airy, high-pitched voice with a musical, whimsical quality"
                },
                {
                  label: "Robot Butler",
                  personality:
                    "An overly polite robot butler who takes everything literally, apologizes constantly, and secretly wants to be a poet",
                  voice:
                    "A crisp, slightly monotone British voice with precise enunciation"
                }
              ] as const
            ).map((preset) => (
              <Button
                key={preset.label}
                variant="outline"
                size="sm"
                disabled={isGenerating || step === "saving"}
                onClick={() => {
                  setPersonality(preset.personality);
                  setVoiceDescription(preset.voice);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      </Surface>

      {/* System prompt preview */}
      {systemPrompt && (
        <Surface className="p-4 rounded-xl ring ring-kumo-line">
          <Text size="xs" bold variant="secondary">
            Generated System Prompt
          </Text>
          <pre className="mt-2 text-xs text-kumo-default whitespace-pre-wrap bg-kumo-elevated rounded-lg p-3 max-h-32 overflow-y-auto">
            {systemPrompt}
          </pre>
        </Surface>
      )}

      {/* Voice previews */}
      {previews.length > 0 && (step === "previewing" || step === "saving") && (
        <div className="space-y-4">
          <Text size="sm" bold>
            Pick a voice
          </Text>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {previews.map((preview) => (
              <VoicePreviewCard
                key={preview.generatedVoiceId}
                preview={preview}
                selected={selectedPreview === preview.generatedVoiceId}
                onSelect={() => setSelectedPreview(preview.generatedVoiceId)}
              />
            ))}
          </div>

          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <span className="text-xs font-medium text-kumo-subtle block mb-2">
              Character Name
            </span>
            <div className="flex gap-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Inspector Bramblewood"
                className="flex-1 px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
              <Button
                variant="primary"
                icon={
                  step === "saving" ? (
                    <SpinnerIcon size={16} className="animate-spin" />
                  ) : (
                    <CheckIcon size={16} />
                  )
                }
                disabled={!name.trim() || !selectedPreview || step === "saving"}
                onClick={save}
              >
                Start Chatting
              </Button>
            </div>
          </Surface>
        </div>
      )}

      {step === "idle" && (
        <Empty
          icon={<UserCircleIcon size={32} />}
          title="Create a character"
          contents="Describe a personality and a voice. ElevenLabs will generate a custom voice, and Workers AI will craft the personality. Then chat with your creation!"
        />
      )}
    </div>
  );
}

function ChatPhase({ agent }: { agent: AgentHandle }) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const character = agent.state?.character;

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) textareaRef.current.focus();
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);

  const reset = useCallback(async () => {
    clearHistory();
    await agent.call("resetCharacter", []);
  }, [agent, clearHistory]);

  return (
    <div className="flex flex-col h-full">
      {/* Character banner */}
      <div className="px-5 py-3 border-b border-kumo-line bg-kumo-base">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <UserCircleIcon size={20} className="text-kumo-accent" />
            <Text size="sm" bold>
              {character?.name ?? "Character"}
            </Text>
            <Badge variant="secondary">
              <SpeakerHighIcon size={10} className="mr-1" />
              Custom voice
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<TrashIcon size={14} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowCounterClockwiseIcon size={14} />}
              onClick={reset}
            >
              New Character
            </Button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-4">
          {messages.length === 0 && (
            <Empty
              icon={<UserCircleIcon size={32} />}
              title={`Chat with ${character?.name ?? "your character"}`}
              contents={
                <div className="flex flex-wrap justify-center gap-2 mt-2">
                  {[
                    "Tell me about yourself",
                    "What do you think of modern technology?",
                    "Tell me a story"
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
                          <SpeakButton
                            onSpeak={() =>
                              agent.call("speak", [text]) as Promise<string>
                            }
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
              placeholder={`Say something to ${character?.name ?? "your character"}...`}
              disabled={isStreaming}
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
                disabled={!input.trim()}
                icon={<PaperPlaneRightIcon size={18} />}
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export function CharacterTab() {
  const [connected, setConnected] = useState(false);

  const agent = useAgent<CharacterAgent, CharacterState>({
    agent: "CharacterAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const phase = agent.state?.phase ?? "idle";

  if (!connected) {
    return (
      <div className="flex items-center justify-center h-full text-kumo-inactive">
        <SpinnerIcon size={24} className="animate-spin" />
      </div>
    );
  }

  if (phase === "chatting" && agent.state?.character) {
    return <ChatPhase agent={agent} />;
  }

  return (
    <DesignPhase
      agent={agent}
      onComplete={() => {
        /* state drives the transition */
      }}
    />
  );
}
