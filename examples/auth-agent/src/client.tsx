/** React client — GitHub sign-in + authenticated chat UI. */

import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  Banner,
  Button,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  GithubLogoIcon,
  InfoIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  fetchCurrentUser,
  signOut,
  startGitHubLogin,
  type AuthUser
} from "./auth-client";

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

function Shell({
  children,
  align = "center"
}: {
  children: ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className="flex flex-col min-h-screen bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="flex items-center justify-end">
          <ModeToggle />
        </div>
      </header>
      <div
        className={`flex-1 py-12 ${
          align === "center" ? "flex items-center justify-center" : ""
        }`}
      >
        <div className="w-full max-w-lg px-6">{children}</div>
      </div>
      <div className="flex justify-center pb-3">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </div>
    </div>
  );
}

function LoadingView() {
  return (
    <Shell>
      <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
            <ShieldCheckIcon
              size={20}
              weight="bold"
              className="text-kumo-brand"
            />
          </div>
          <Text variant="heading1">GitHub Auth Agent</Text>
        </div>
        <Text variant="secondary">Checking your authentication status...</Text>
      </Surface>
    </Shell>
  );
}

function SignInView({ error }: { error: string | null }) {
  return (
    <Shell>
      <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
              <GithubLogoIcon
                size={20}
                weight="fill"
                className="text-kumo-brand"
              />
            </div>
            <Text variant="heading1">GitHub Auth Agent</Text>
          </div>
          <Text variant="secondary">
            Sign in with GitHub, then connect to a user-scoped agent chosen by
            the Worker. No local token storage, no browser-chosen room names.
          </Text>
        </div>

        <Surface className="p-4 rounded-xl ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div>
              <Text size="sm" bold>
                Before you start
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Create a GitHub OAuth App and add `GITHUB_CLIENT_ID` plus
                  `GITHUB_CLIENT_SECRET` to `.env`. The README walks through the
                  exact callback URL to use for local development.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        {error && (
          <div className="mt-6">
            <Banner variant="error">{error}</Banner>
          </div>
        )}

        <div className="border-t border-kumo-line my-8" />

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          icon={<GithubLogoIcon size={18} weight="fill" />}
          onClick={startGitHubLogin}
        >
          Sign in with GitHub
        </Button>
      </Surface>
    </Shell>
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

function ChatView({
  user,
  onSignOut,
  onAuthLost
}: {
  user: AuthUser;
  onSignOut: () => void;
  onAuthLost: () => void;
}) {
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const displayName = user.name || user.login;

  const verifyAuth = useCallback(async () => {
    try {
      const currentUser = await fetchCurrentUser();
      if (!currentUser) {
        onAuthLost();
      }
    } catch (fetchError) {
      console.error("Failed to verify auth state:", fetchError);
    }
  }, [onAuthLost]);

  const handleOpen = useCallback(() => setWsStatus("connected"), []);
  const handleClose = useCallback(() => {
    setWsStatus("disconnected");
    void verifyAuth();
  }, [verifyAuth]);

  const agent = useAgent({
    agent: "ChatAgent",
    basePath: "chat",
    onOpen: handleOpen,
    onClose: handleClose
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
    setError(null);
    setIsSigningOut(true);

    try {
      await signOut();
      onSignOut();
    } catch {
      setError("Failed to sign out");
    } finally {
      setIsSigningOut(false);
    }
  }, [onSignOut]);

  return (
    <div className="h-screen flex flex-col bg-kumo-base">
      <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-kumo-line">
        <div className="flex items-center gap-3">
          <ShieldCheckIcon
            size={20}
            weight="bold"
            className="text-kumo-brand"
          />
          <Text variant="heading3">GitHub Auth Agent</Text>
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
            loading={isSigningOut}
          >
            Sign out
          </Button>
        </div>
      </header>

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
                    Signed in as {displayName} (`{user.login}`). The browser
                    connects to `/chat`, and the Worker resolves the real agent
                    instance from your GitHub identity before forwarding the
                    request.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {error && <Banner variant="error">{error}</Banner>}

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
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const loadUser = async () => {
      try {
        const currentUser = await fetchCurrentUser(controller.signal);
        setUser(currentUser);
        setError(null);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        ) {
          return;
        }

        setUser(null);
        setError("Failed to load the current auth state");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadUser();

    return () => controller.abort();
  }, []);

  if (isLoading) {
    return <LoadingView />;
  }

  if (user) {
    return (
      <ChatView
        user={user}
        onSignOut={() => {
          setUser(null);
          setError(null);
        }}
        onAuthLost={() => {
          setUser(null);
          setError(null);
        }}
      />
    );
  }

  return <SignInView error={error} />;
}

export default function AppWrapper() {
  return <App />;
}
