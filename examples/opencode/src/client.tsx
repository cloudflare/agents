import "./styles.css";
import { createRoot } from "react-dom/client";
import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  Button,
  InputArea,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  InfoIcon
} from "@phosphor-icons/react";

import { ChatMessages } from "./client/chat-messages";
import {
  ConnectionIndicator,
  type ConnectionStatus
} from "./client/connection-indicator";
import { ModeToggle } from "./client/mode-toggle";
import { ErrorBoundary } from "./client/error-boundary";

const STORAGE_KEY = "opencode-session-id";
const OLD_STORAGE_KEY = "sandbox-chat-session-id";

/**
 * Encode a UUID as base32 (lowercase, no padding).
 * Uses Crockford-style alphabet: 0-9 a-v.
 */
function uuidToBase32(): string {
  const uuid = crypto.randomUUID();
  // Parse UUID hex string into bytes
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // RFC 4648 base32 encoding (lowercase, no padding)
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "default";
  // Clean up old storage key from before the rename
  localStorage.removeItem(OLD_STORAGE_KEY);
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = uuidToBase32();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

function newSessionId(): string {
  const id = uuidToBase32();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState(getOrCreateSessionId);

  const agent = useAgent<{ model?: string }>({
    agent: "SandboxChatAgent",
    name: sessionId,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

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
    <div className="flex h-screen bg-kumo-elevated">
      {/* Single column — chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-kumo-default">
                OpenCode
                {agent.state?.model && (
                  <span className="text-sm font-normal text-kumo-inactive ml-1">
                    ({agent.state.model})
                  </span>
                )}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={() => {
                  clearHistory();
                  setSessionId(newSessionId());
                }}
              >
                New Session
              </Button>
            </div>
          </div>
        </header>

        {/* Explainer */}
        <div className="px-5 pt-4">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  OpenCode Agent
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    Delegate coding tasks to an autonomous AI agent running in
                    an isolated sandbox. Describe what you want built and the
                    agent will handle files, commands, and tools — streaming
                    progress back in real time.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>
        </div>

        {/* Messages */}
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          messagesEndRef={messagesEndRef}
          sandboxId={sessionId}
        />

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
                placeholder='Try: "Build me a todo app with React" or "Create a REST API with Hono"'
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
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </ErrorBoundary>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
