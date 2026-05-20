import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Empty,
  InputArea,
  Surface,
  Text,
  PoweredByCloudflare,
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  MagnifyingGlassIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  BugIcon,
  MoonIcon,
  SunIcon,
} from "@phosphor-icons/react";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="text-xs text-kumo-subtle">{label}</span>
    </output>
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

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");
}

function detectVerdict(text: string): "pass" | "fail" | null {
  if (/\bPASS\b/.test(text)) return "pass";
  if (/\bFAIL\b/.test(text)) return "fail";
  return null;
}

function VerdictBadge({ verdict }: { verdict: "pass" | "fail" }) {
  if (verdict === "pass") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-semibold">
        <CheckCircleIcon size={12} weight="fill" />
        PASS
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-xs font-semibold">
      <XCircleIcon size={12} weight="fill" />
      FAIL
    </span>
  );
}

function PageCheckToolCall({
  input,
  output,
  isRunning,
  isError,
  errorText,
}: {
  input: Record<string, unknown> | undefined;
  output: unknown;
  isRunning: boolean;
  isError: boolean;
  errorText?: string;
}) {
  const checks = Array.isArray(input?.checks)
    ? (input.checks as Array<{ type: string; selector?: string; name: string }>)
    : [];
  const url = typeof input?.url === "string" ? input.url : null;
  const resultData =
    output != null &&
    typeof output === "object" &&
    "data" in (output as object)
      ? (output as { url: string; data: Record<string, unknown> })
      : null;

  return (
    <Surface className="max-w-[90%] px-4 py-3 rounded-xl ring ring-kumo-line overflow-hidden">
      <div className="flex items-center gap-2 mb-2">
        {isRunning ? (
          <MagnifyingGlassIcon
            size={14}
            className="text-kumo-accent animate-pulse"
          />
        ) : isError ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : (
          <MagnifyingGlassIcon size={14} className="text-kumo-subtle" />
        )}
        <Text size="xs" variant="secondary" bold>
          {isRunning ? "Inspecting page..." : "Page inspection"}
        </Text>
        {!isRunning && !isError && (
          <span className="text-[10px] text-kumo-inactive bg-kumo-elevated px-1.5 py-0.5 rounded-full">
            Done
          </span>
        )}
      </div>

      {url && (
        <div className="mb-2">
          <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
            URL
          </span>
          <p className="mt-0.5 text-xs font-mono text-kumo-subtle truncate">
            {url}
          </p>
        </div>
      )}

      {checks.length > 0 && (
        <div className="mb-2">
          <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
            Checks ({checks.length})
          </span>
          <div className="mt-1 flex flex-wrap gap-1">
            {checks.map((check, i) => (
              <span
                key={i}
                className="text-[10px] font-mono bg-kumo-elevated text-kumo-subtle px-1.5 py-0.5 rounded"
              >
                {check.type}:{check.name}
                {check.selector ? `[${check.selector}]` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {errorText && (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-red-400 font-semibold">
            Error
          </span>
          <pre className="mt-1 p-2 rounded-lg bg-red-50 dark:bg-red-950/20 text-xs font-mono text-red-600 dark:text-red-400 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
            {errorText}
          </pre>
        </div>
      )}

      {resultData && (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-kumo-inactive font-semibold">
            Extracted data
          </span>
          <div className="mt-1 space-y-1">
            {Object.entries(resultData.data).map(([key, value]) => (
              <div key={key} className="flex gap-2 text-xs">
                <span className="font-mono text-kumo-accent shrink-0">{key}:</span>
                <span className="text-kumo-subtle break-all">
                  {Array.isArray(value)
                    ? `[${(value as unknown[]).slice(0, 3).join(", ")}${(value as unknown[]).length > 3 ? `, +${(value as unknown[]).length - 3} more` : ""}]`
                    : String(value ?? "null")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Surface>
  );
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "QAAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback((e: Event) => console.error("WebSocket error:", e), []),
  });

  const { messages, sendMessage, clearHistory, stop, isStreaming } =
    useAgentChat({ agent });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const isConnected = connectionStatus === "connected";

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BugIcon size={20} className="text-kumo-accent" />
            <h1 className="text-lg font-semibold text-kumo-default">
              QA Agent
            </h1>
            <span className="text-xs text-kumo-subtle bg-kumo-elevated px-2 py-0.5 rounded-full">
              Puppeteer
            </span>
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

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<BugIcon size={32} />}
              title="QA Agent"
              description='Describe what to check on a page. Try: "Check that https://example.com has a friendly-sounding title" or "Does https://cloudflare.com look like a trustworthy company site?"'
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
                    const verdict = detectVerdict(part.text);
                    const isLastText = message.parts
                      .slice(partIndex + 1)
                      .every((p) => p.type !== "text");
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          {verdict && (
                            <div className="mb-2">
                              <VerdictBadge verdict={verdict} />
                            </div>
                          )}
                          <div className="whitespace-pre-wrap">
                            {part.text}
                            {isLastAssistant && isLastText && isStreaming && (
                              <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (part.type === "reasoning") {
                    if (!part.text) return null;
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon size={14} className="text-kumo-inactive" />
                            <Text size="xs" variant="secondary" bold>
                              Thinking
                            </Text>
                          </div>
                          <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                            {part.text}
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  if (!isToolUIPart(part)) return null;

                  const toolName = getToolName(part);
                  const toolInput = part.input as
                    | Record<string, unknown>
                    | undefined;
                  const toolOutput = (part as { output?: unknown }).output;
                  const errorText = (part as { errorText?: string }).errorText;
                  const isRunning =
                    part.state === "input-available" ||
                    part.state === "input-streaming";
                  const isError = part.state === "output-error";

                  if (toolName === "run_page_check") {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <PageCheckToolCall
                          input={toolInput}
                          output={toolOutput}
                          isRunning={isRunning}
                          isError={isError}
                          errorText={errorText}
                        />
                      </div>
                    );
                  }

                  // Fallback for any other tools
                  return (
                    <div key={part.toolCallId} className="flex justify-start">
                      <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line overflow-hidden">
                        <div className="flex items-center gap-2">
                          <GearIcon
                            size={14}
                            className={
                              isRunning
                                ? "text-kumo-inactive animate-spin"
                                : "text-kumo-inactive"
                            }
                          />
                          <Text size="xs" variant="secondary" bold>
                            {toolName}
                          </Text>
                        </div>
                        {errorText && (
                          <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap break-all">
                            {errorText}
                          </pre>
                        )}
                      </Surface>
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

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
              placeholder='Try: "Check that https://example.com has a happy sounding title"'
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop"
                onClick={stop}
                icon={<StopIcon size={18} weight="fill" />}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send"
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

export default function App() {
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
