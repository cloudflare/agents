/** React client — sign-in/sign-up form + authenticated chat UI. */

import {
  Suspense,
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
  Link,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  SignOutIcon,
  ShieldCheckIcon,
  LockKeyIcon,
  TrashIcon,
  SunIcon,
  MoonIcon,
  LinkIcon
} from "@phosphor-icons/react";
import { authClient, fetchAndStoreJwt, clearTokens } from "./auth-client";

// ── Connection status pill ───────────────────────────────────────────────────

type WsStatus = "connected" | "connecting" | "disconnected";

const statusConfig = {
  connected: {
    label: "Connected",
    dot: "bg-green-500",
    text: "text-kumo-success",
    bg: "bg-green-500/10"
  },
  connecting: {
    label: "Connecting\u2026",
    dot: "bg-kumo-warning animate-pulse",
    text: "text-kumo-warning",
    bg: "bg-kumo-warning-tint"
  },
  disconnected: {
    label: "Disconnected",
    dot: "bg-kumo-danger",
    text: "text-kumo-danger",
    bg: "bg-kumo-danger-tint"
  }
} as const;

function ConnectionStatus({ status }: { status: WsStatus }) {
  const cfg = statusConfig[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Dark / light mode toggle ─────────────────────────────────────────────────

function ModeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={dark ? <MoonIcon size={16} /> : <SunIcon size={16} />}
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    />
  );
}

// ── Auth form ────────────────────────────────────────────────────────────────

function AuthForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      setLoading(true);

      try {
        // Sign in or sign up — better-auth sets a session cookie
        // on the browser automatically (same-origin).
        if (mode === "signin") {
          const { error: err } = await authClient.signIn.email({
            email,
            password
          });
          if (err) {
            setError(err.message ?? "Sign in failed");
            return;
          }
        } else {
          const { error: err } = await authClient.signUp.email({
            email,
            password,
            name: name || email.split("@")[0]
          });
          if (err) {
            setError(err.message ?? "Sign up failed");
            return;
          }
        }

        // Fetch a short-lived JWT for agent WebSocket connections.
        // The session cookie authenticates this request automatically.
        await fetchAndStoreJwt();
        onSuccess();
      } catch {
        setError("An unexpected error occurred");
      } finally {
        setLoading(false);
      }
    },
    [email, password, name, mode, onSuccess]
  );

  return (
    <div className="flex items-center justify-center min-h-screen bg-kumo-base py-12">
      <div className="w-full max-w-lg px-6">
        <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
          <form onSubmit={handleSubmit}>
            {/* Header */}
            <div className="mb-10">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
                  <LockKeyIcon
                    size={20}
                    weight="bold"
                    className="text-kumo-brand"
                  />
                </div>
                <Text variant="heading1">
                  {mode === "signin" ? "Sign in" : "Create account"}
                </Text>
              </div>
              <Text variant="secondary">
                {mode === "signin"
                  ? "Sign in to connect to the secured agent."
                  : "Create an account to get started."}
              </Text>
            </div>

            {/* Fields */}
            <div className="space-y-6">
              {mode === "signup" && (
                <div className="flex flex-col gap-2.5">
                  <Label>Name</Label>
                  <Input
                    size="lg"
                    placeholder="Your name"
                    aria-label="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                <Label>Email</Label>
                <Input
                  size="lg"
                  type="email"
                  placeholder="you@example.com"
                  aria-label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="flex flex-col gap-2.5">
                <Label>Password</Label>
                <Input
                  size="lg"
                  type="password"
                  placeholder="Min 8 characters"
                  aria-label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={
                    mode === "signin" ? "current-password" : "new-password"
                  }
                />
              </div>
            </div>

            {error && (
              <div className="mt-6">
                <Banner variant="error">{error}</Banner>
              </div>
            )}

            {/* Divider */}
            <div className="border-t border-kumo-line my-8" />

            {/* Actions */}
            <div className="space-y-5">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                loading={loading}
                disabled={!email || !password || loading}
              >
                {mode === "signin" ? "Sign in" : "Sign up"}
              </Button>

              <div className="text-center">
                <Text variant="secondary" size="sm">
                  {mode === "signin" ? "No account? " : "Have an account? "}
                  <button
                    type="button"
                    className="text-kumo-brand underline underline-offset-2 hover:no-underline"
                    onClick={() => {
                      setMode(mode === "signin" ? "signup" : "signin");
                      setError(null);
                    }}
                  >
                    {mode === "signin" ? "Sign up" : "Sign in"}
                  </button>
                </Text>
              </div>
            </div>
          </form>
        </Surface>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-between px-2">
          <Text variant="secondary" size="xs">
            <LinkIcon size={12} className="inline mr-1 align-text-bottom" />
            Secured with{" "}
            <Link
              href="https://www.better-auth.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              better-auth
            </Link>
            {" + "}
            <Link
              href="https://developers.cloudflare.com/agents/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Agents SDK
            </Link>
          </Text>
          <ModeToggle />
        </div>
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
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(() => setWsStatus("connected"), []);
  const handleClose = useCallback(() => setWsStatus("disconnected"), []);

  const agent = useAgent({
    agent: "SecuredChatAgent",
    name: "default",
    onOpen: handleOpen,
    onClose: handleClose,
    query: async () => ({
      token: localStorage.getItem("jwt_token") || ""
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

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    clearTokens();
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
          <ConnectionStatus status={wsStatus} />
        </div>
        <div className="flex items-center gap-2">
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
            className="!rounded-full !px-4 !py-2"
          >
            Sign out
          </Button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
          {messages.length === 0 && (
            <Surface className="p-6 rounded-lg ring ring-kumo-line text-center">
              <ShieldCheckIcon
                size={32}
                className="mx-auto mb-3 text-kumo-success"
              />
              <Text variant="heading3">Authenticated</Text>
              <div className="mt-1">
                <Text variant="secondary" size="sm">
                  You're connected to a secured agent via JWT. Send a message to
                  get started.
                </Text>
              </div>
            </Surface>
          )}

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
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
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
      </div>
    </div>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

function App() {
  // Auth state tracked via localStorage JWT presence, not useSession().
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => !!localStorage.getItem("jwt_token")
  );

  if (isAuthenticated) {
    return <ChatView onSignOut={() => setIsAuthenticated(false)} />;
  }

  return <AuthForm onSuccess={() => setIsAuthenticated(true)} />;
}

export default function AppWrapper() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen bg-kumo-base">
          <Text variant="secondary">Loading...</Text>
        </div>
      }
    >
      <App />
    </Suspense>
  );
}
