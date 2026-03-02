/** React client — name form + authenticated chat UI. */

import {
  useCallback,
  useState,
  useEffect,
  useRef,
  type FormEvent
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  Banner,
  Button,
  Input,
  InputArea,
  Label,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  SignOutIcon,
  ShieldCheckIcon,
  LockKeyIcon,
  TrashIcon,
  InfoIcon
} from "@phosphor-icons/react";
import {
  fetchToken,
  getToken,
  getUserName,
  clearAuth,
  isTokenExpired
} from "./auth-client";

// ── Name form ────────────────────────────────────────────────────────────────

function NameForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      setLoading(true);

      try {
        await fetchToken(name.trim());
        onSuccess();
      } catch {
        setError("Failed to authenticate");
      } finally {
        setLoading(false);
      }
    },
    [name, onSuccess]
  );

  return (
    <div className="flex flex-col min-h-screen bg-kumo-base">
      {/* Header */}
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="flex items-center justify-end">
          <ModeToggle />
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="w-full max-w-lg px-6">
          <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
            <form onSubmit={handleSubmit}>
              <div className="mb-10">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
                    <LockKeyIcon
                      size={20}
                      weight="bold"
                      className="text-kumo-brand"
                    />
                  </div>
                  <Text variant="heading1">Auth Agent</Text>
                </div>
                <Text variant="secondary">
                  Enter your name to get a JWT and connect to the agent.
                </Text>
              </div>

              <div className="flex flex-col gap-2.5">
                <Label>Name</Label>
                <Input
                  size="lg"
                  placeholder="Your name"
                  aria-label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </div>

              {error && (
                <div className="mt-6">
                  <Banner variant="error">{error}</Banner>
                </div>
              )}

              <div className="border-t border-kumo-line my-8" />

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                loading={loading}
                disabled={!name.trim() || loading}
              >
                Connect
              </Button>
            </form>
          </Surface>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-center pb-3">
        <PoweredByAgents />
      </div>
    </div>
  );
}

// ── Chat view (authenticated) ────────────────────────────────────────────────

function getMessageText(message: {
  parts: Array<{ type: string; text?: string }>;
}): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

function ChatView({ onSignOut }: { onSignOut: () => void }) {
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userName = getUserName() ?? "user";

  const handleOpen = useCallback(() => setWsStatus("connected"), []);
  const handleClose = useCallback(() => {
    if (isTokenExpired()) {
      clearAuth();
      onSignOut();
      return;
    }
    setWsStatus("disconnected");
  }, [onSignOut]);

  const agent = useAgent({
    agent: "ChatAgent",
    name: userName,
    onOpen: handleOpen,
    onClose: handleClose,
    query: async () => ({
      token: getToken() || ""
    })
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = wsStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    try {
      await sendMessage({
        role: "user",
        parts: [{ type: "text", text }]
      });
    } catch (err) {
      console.error("Failed to send message:", err);
    }
  }, [input, isStreaming, sendMessage]);

  const handleSignOut = useCallback(() => {
    clearAuth();
    onSignOut();
  }, [onSignOut]);

  return (
    <div className="h-screen flex flex-col bg-kumo-base">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-kumo-line">
        <div className="flex items-center gap-3">
          <ShieldCheckIcon
            size={20}
            weight="bold"
            className="text-kumo-brand"
          />
          <Text variant="heading3">Auth Agent</Text>
          <ConnectionIndicator status={wsStatus} />
        </div>
        <div className="flex items-center gap-3">
          <ModeToggle />
          <Button
            variant="ghost"
            size="sm"
            icon={<TrashIcon size={16} />}
            onClick={clearHistory}
            title="Clear chat history"
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<SignOutIcon size={16} />}
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Authenticated Agent
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    Connected as {userName}. Your JWT is verified on every
                    WebSocket connection. The agent knows your name from the
                    token claims.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const text = getMessageText(message);
            const isLastAssistant = !isUser && index === messages.length - 1;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-kumo-contrast text-kumo-inverse text-sm leading-relaxed whitespace-pre-wrap">
                    {text}
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="flex justify-start">
                <Surface className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-bl-sm ring ring-kumo-line text-sm leading-relaxed whitespace-pre-wrap">
                  {text}
                  {isLastAssistant && isStreaming && (
                    <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                  )}
                </Surface>
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-6 py-4"
        >
          <Surface className="flex items-end gap-3 rounded-xl ring ring-kumo-line p-3 focus-within:ring-kumo-interact transition-shadow">
            <InputArea
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Type a message..."
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={!input.trim() || !isConnected || isStreaming}
              className="shrink-0 mb-0.5 w-10 h-10 flex items-center justify-center rounded-lg bg-kumo-brand text-white disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all"
            >
              <PaperPlaneRightIcon size={18} />
            </button>
          </Surface>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByAgents />
        </div>
      </div>
    </div>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    if (isTokenExpired()) {
      clearAuth();
      return false;
    }
    return true;
  });

  if (isAuthenticated) {
    return <ChatView onSignOut={() => setIsAuthenticated(false)} />;
  }

  return <NameForm onSuccess={() => setIsAuthenticated(true)} />;
}

export default function AppWrapper() {
  return <App />;
}
