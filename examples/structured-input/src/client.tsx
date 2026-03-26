import "./styles.css";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import type {
  MultipleChoiceInput as MCInput,
  YesNoInput as YNInput,
  FreeTextInput as FTInput,
  RatingInput as RTInput
} from "./tools";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  ChatCircleDotsIcon,
  ListBulletsIcon,
  CheckIcon,
  StarIcon,
  TextAaIcon,
  InfoIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </div>
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

// --- Structured input components ---

function MultipleChoiceInput({
  question,
  options,
  allowMultiple,
  onSubmit
}: {
  question: string;
  options: string[];
  allowMultiple: boolean;
  onSubmit: (selected: string | string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  const toggle = (index: number) => {
    if (submitted) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (allowMultiple) {
        if (next.has(index)) next.delete(index);
        else next.add(index);
      } else {
        next.clear();
        next.add(index);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (submitted) return;
    setSubmitted(true);
    const picks = [...selected].map((i) => options[i]);
    onSubmit(allowMultiple ? picks : picks[0]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ListBulletsIcon
          size={16}
          weight="bold"
          className="text-kumo-accent shrink-0"
        />
        <span className="text-sm font-medium text-kumo-default">
          {question}
        </span>
      </div>
      {allowMultiple && (
        <span className="text-xs text-kumo-subtle block">
          Select all that apply
        </span>
      )}
      <div className="space-y-1.5">
        {options.map((option, i) => {
          const isSelected = selected.has(i);
          return (
            <button
              key={i}
              type="button"
              disabled={submitted}
              onClick={() => toggle(i)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all border ${
                isSelected
                  ? "border-kumo-accent bg-kumo-accent/10 text-kumo-default font-medium"
                  : "border-kumo-line bg-kumo-base text-kumo-default hover:border-kumo-accent/50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`size-4 border flex items-center justify-center shrink-0 ${
                    allowMultiple ? "rounded-sm" : "rounded-full"
                  } ${
                    isSelected
                      ? "border-kumo-accent bg-kumo-accent"
                      : "border-kumo-line"
                  }`}
                >
                  {isSelected && (
                    <CheckIcon size={10} weight="bold" className="text-white" />
                  )}
                </span>
                {option}
              </span>
            </button>
          );
        })}
      </div>
      <Button
        variant="primary"
        size="sm"
        disabled={selected.size === 0 || submitted}
        onClick={handleSubmit}
      >
        {submitted ? "Submitted" : "Confirm"}
      </Button>
    </div>
  );
}

function YesNoInput({
  question,
  onSubmit
}: {
  question: string;
  onSubmit: (answer: boolean) => void;
}) {
  const [submitted, setSubmitted] = useState(false);

  const handle = (answer: boolean) => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit(answer);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ChatCircleDotsIcon
          size={16}
          weight="bold"
          className="text-kumo-accent shrink-0"
        />
        <span className="text-sm font-medium text-kumo-default">
          {question}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={submitted}
          onClick={() => handle(true)}
        >
          Yes
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={submitted}
          onClick={() => handle(false)}
        >
          No
        </Button>
      </div>
    </div>
  );
}

function FreeTextInput({
  question,
  placeholder,
  multiline,
  onSubmit
}: {
  question: string;
  placeholder?: string;
  multiline: boolean;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handle = () => {
    if (submitted || !value.trim()) return;
    setSubmitted(true);
    onSubmit(value.trim());
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <TextAaIcon
          size={16}
          weight="bold"
          className="text-kumo-accent shrink-0"
        />
        <span className="text-sm font-medium text-kumo-default">
          {question}
        </span>
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder || "Type your answer..."}
          disabled={submitted}
          rows={3}
          className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent resize-y"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder || "Type your answer..."}
          disabled={submitted}
          onKeyDown={(e) => {
            if (e.key === "Enter") handle();
          }}
          className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
        />
      )}
      <Button
        variant="primary"
        size="sm"
        disabled={!value.trim() || submitted}
        onClick={handle}
      >
        {submitted ? "Submitted" : "Submit"}
      </Button>
    </div>
  );
}

function RatingInput({
  question,
  min,
  max,
  labels,
  onSubmit
}: {
  question: string;
  min: number;
  max: number;
  labels?: { low?: string; high?: string };
  onSubmit: (rating: number) => void;
}) {
  const [hovering, setHovering] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const count = max - min + 1;

  const handle = () => {
    if (submitted || selected === null) return;
    setSubmitted(true);
    onSubmit(selected);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StarIcon
          size={16}
          weight="bold"
          className="text-kumo-accent shrink-0"
        />
        <span className="text-sm font-medium text-kumo-default">
          {question}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {Array.from({ length: count }, (_, i) => {
          const value = min + i;
          const active =
            hovering !== null ? value <= hovering : value <= (selected ?? -1);
          return (
            <button
              key={value}
              type="button"
              disabled={submitted}
              onMouseEnter={() => setHovering(value)}
              onMouseLeave={() => setHovering(null)}
              onClick={() => setSelected(value)}
              className="p-0.5 transition-transform hover:scale-110"
              aria-label={`Rate ${value}`}
            >
              <StarIcon
                size={24}
                weight={active ? "fill" : "regular"}
                className={active ? "text-amber-400" : "text-kumo-inactive"}
              />
            </button>
          );
        })}
      </div>
      {labels && (
        <div className="flex justify-between text-xs text-kumo-subtle px-1">
          <span>{labels.low || min}</span>
          <span>{labels.high || max}</span>
        </div>
      )}
      <Button
        variant="primary"
        size="sm"
        disabled={selected === null || submitted}
        onClick={handle}
      >
        {submitted
          ? "Submitted"
          : `Confirm${selected !== null ? ` (${selected})` : ""}`}
      </Button>
    </div>
  );
}

function CompletedAnswer({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <CheckIcon size={14} weight="bold" className="text-kumo-success" />
      <span className="text-xs text-kumo-subtle">{label}:</span>
      <Badge variant="secondary">{value}</Badge>
    </div>
  );
}

function ToolError({ error }: { error: string }) {
  return (
    <div className="flex items-center gap-2 text-kumo-danger">
      <span className="text-xs">Error: {error}</span>
    </div>
  );
}

function StreamingSkeleton({
  icon: Icon
}: {
  icon: React.ComponentType<{ size: number; className?: string }>;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={14} className="text-kumo-inactive animate-pulse" />
      <span className="text-xs text-kumo-subtle">Preparing question...</span>
    </div>
  );
}

function ToolPartWrapper({
  toolCallId,
  active,
  children
}: {
  toolCallId: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div key={toolCallId} className="flex justify-start">
      <Surface
        className={`max-w-[85%] px-4 py-3 rounded-xl ${
          active ? "ring-2 ring-kumo-accent" : "ring ring-kumo-line"
        }`}
      >
        {children}
      </Surface>
    </div>
  );
}

// --- Main chat ---

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "StructuredInputAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, addToolOutput, stop, status } =
    useAgentChat({ agent });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Structured Input
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Interactive
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {/* Explainer */}
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  LLM-Driven Structured Input
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This demo shows how an AI agent can present interactive
                    forms — multiple choice, yes/no, free text, and rating
                    scales — using client-side tools. The LLM decides which
                    input type to use based on conversation context. Try asking
                    it to help you plan a trip, run a survey, or gather project
                    requirements.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Start a conversation"
              description='Try "Help me plan a vacation" or "Run a quick survey about my coffee preferences" or "Help me pick a tech stack for my project"'
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                    {getMessageText(message)}
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIndex) => {
                  if (part.type === "text") {
                    if (!part.text) return null;
                    const isLastTextPart = message.parts
                      .slice(partIndex + 1)
                      .every((p) => p.type !== "text");
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <div className="whitespace-pre-wrap">
                            {part.text}
                            {isLastAssistant &&
                              isLastTextPart &&
                              isStreaming && (
                                <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                              )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // --- Multiple Choice ---
                  if (part.type === "tool-askMultipleChoice") {
                    const inp = part.input as MCInput;
                    if (part.state === "output-available") {
                      const answer = Array.isArray(part.output)
                        ? part.output.join(", ")
                        : String(part.output);
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <CompletedAnswer
                            label={inp.question}
                            value={answer}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "output-error") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <ToolError
                            error={part.errorText ?? "Unknown error"}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                          active
                        >
                          <MultipleChoiceInput
                            question={inp.question}
                            options={inp.options}
                            allowMultiple={inp.allowMultiple ?? false}
                            onSubmit={(selected) =>
                              addToolOutput({
                                toolCallId: part.toolCallId,
                                output: selected
                              })
                            }
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-streaming") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <StreamingSkeleton icon={ListBulletsIcon} />
                        </ToolPartWrapper>
                      );
                    }
                    return null;
                  }

                  // --- Yes/No ---
                  if (part.type === "tool-askYesNo") {
                    const inp = part.input as YNInput;
                    if (part.state === "output-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <CompletedAnswer
                            label={inp.question}
                            value={part.output ? "Yes" : "No"}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "output-error") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <ToolError
                            error={part.errorText ?? "Unknown error"}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                          active
                        >
                          <YesNoInput
                            question={inp.question}
                            onSubmit={(answer) =>
                              addToolOutput({
                                toolCallId: part.toolCallId,
                                output: answer
                              })
                            }
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-streaming") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <StreamingSkeleton icon={ChatCircleDotsIcon} />
                        </ToolPartWrapper>
                      );
                    }
                    return null;
                  }

                  // --- Free Text ---
                  if (part.type === "tool-askFreeText") {
                    const inp = part.input as FTInput;
                    if (part.state === "output-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <CompletedAnswer
                            label={inp.question}
                            value={String(part.output)}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "output-error") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <ToolError
                            error={part.errorText ?? "Unknown error"}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                          active
                        >
                          <FreeTextInput
                            question={inp.question}
                            placeholder={inp.placeholder}
                            multiline={inp.multiline ?? false}
                            onSubmit={(text) =>
                              addToolOutput({
                                toolCallId: part.toolCallId,
                                output: text
                              })
                            }
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-streaming") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <StreamingSkeleton icon={TextAaIcon} />
                        </ToolPartWrapper>
                      );
                    }
                    return null;
                  }

                  // --- Rating ---
                  if (part.type === "tool-askRating") {
                    const inp = part.input as RTInput;
                    if (part.state === "output-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <CompletedAnswer
                            label={inp.question}
                            value={`${part.output} / ${inp.max ?? 5}`}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "output-error") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <ToolError
                            error={part.errorText ?? "Unknown error"}
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-available") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                          active
                        >
                          <RatingInput
                            question={inp.question}
                            min={inp.min ?? 1}
                            max={inp.max ?? 5}
                            labels={inp.labels}
                            onSubmit={(rating) =>
                              addToolOutput({
                                toolCallId: part.toolCallId,
                                output: rating
                              })
                            }
                          />
                        </ToolPartWrapper>
                      );
                    }
                    if (part.state === "input-streaming") {
                      return (
                        <ToolPartWrapper
                          key={part.toolCallId}
                          toolCallId={part.toolCallId}
                        >
                          <StreamingSkeleton icon={StarIcon} />
                        </ToolPartWrapper>
                      );
                    }
                    return null;
                  }

                  return null;
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
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder='Try: "Help me plan a vacation" or "Run a coffee preferences survey"'
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop streaming"
                onClick={stop}
                icon={<StopIcon size={18} weight="fill" />}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !isConnected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
