import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Surface, Text, PoweredByCloudflare } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  WrenchIcon,
  CodeIcon,
  ShieldCheckIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";
import { nanoid } from "nanoid";
import "./styles.css";

let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("sessionId", sessionId);
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
};

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

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [busy, setBusy] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const agent = useAgent({
    agent: "chat",
    name: sessionId!,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const refreshPending = useCallback(async () => {
    try {
      const next = (await agent.call("pendingApprovals")) as PendingAction[];
      setPending(next ?? []);
    } catch {
      // agent not ready yet
    }
  }, [agent]);

  // Refresh the approval queue whenever a turn settles.
  useEffect(() => {
    if (status === "ready") refreshPending();
  }, [status, messages, refreshPending]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const message = input;
    setInput("");
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }]
    });
  };

  const approve = async (action: PendingAction) => {
    setBusy(true);
    try {
      await agent.call("approveExecution", [action.executionId]);
      await refreshPending();
      await sendMessage({
        role: "user",
        parts: [
          {
            type: "text",
            text: `I approved ${action.connector}.${action.method}. Please continue and summarize the result.`
          }
        ]
      });
    } finally {
      setBusy(false);
    }
  };

  const reject = async (action: PendingAction) => {
    setBusy(true);
    try {
      await agent.call("rejectExecution", [action.executionId, action.seq]);
      await refreshPending();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CodeIcon size={22} className="text-kumo-accent" weight="bold" />
            <h1 className="text-lg font-semibold text-kumo-default">
              Codemode Connectors
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="ghost"
              size="sm"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-4">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <CodeIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  One tool, many connectors
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    The model gets a single <code>codemode</code> tool that runs
                    TypeScript in a sandbox. A GitHub-style MCP server and an
                    OpenAPI service are exposed as <code>github</code> and{" "}
                    <code>repoApi</code>. Writes like{" "}
                    <code>github.create_issue</code> pause for your approval
                    below.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {pending.length > 0 && (
            <Surface className="p-4 rounded-xl ring ring-kumo-warning">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheckIcon
                  size={16}
                  weight="bold"
                  className="text-kumo-warning"
                />
                <Text size="sm" bold>
                  Approval required
                </Text>
              </div>
              <div className="space-y-3">
                {pending.map((action) => (
                  <div
                    key={`${action.executionId}-${action.seq}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-mono text-kumo-default truncate">
                        {action.connector}.{action.method}
                      </div>
                      <div className="text-xs font-mono text-kumo-subtle truncate">
                        {JSON.stringify(action.args)}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => approve(action)}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => reject(action)}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Surface>
          )}

          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Text size="sm" variant="secondary">
                Try one of these:
              </Text>
              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {[
                  "List open pull requests for cloudflare/agents",
                  "Get repo metadata and latest releases for cloudflare/agents",
                  "Open an issue titled 'Docs typo' on cloudflare/agents"
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setInput(prompt)}
                    className="px-3 py-1.5 text-xs rounded-full border border-kumo-line text-kumo-subtle hover:bg-kumo-elevated"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <Surface
                  className={`max-w-md px-4 py-2.5 rounded-xl ${
                    message.role === "user"
                      ? "bg-kumo-accent text-black"
                      : "ring ring-kumo-line"
                  }`}
                >
                  {message.parts
                    ?.filter((part) => part.type === "text")
                    .map((part, i) => (
                      <div
                        key={`${part.type}-${i}`}
                        className="whitespace-pre-wrap text-sm"
                      >
                        {part.text}
                      </div>
                    ))}
                  {message.parts
                    ?.filter((part) => part.type.startsWith("tool-"))
                    .map((part, i) => (
                      <div
                        key={`tool-${i}`}
                        className="mt-1 text-xs font-mono text-kumo-subtle"
                      >
                        <WrenchIcon
                          size={12}
                          className="inline mr-1"
                          weight="bold"
                        />
                        codemode
                      </div>
                    ))}
                </Surface>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <div className="border-t border-kumo-line p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-2">
          <input
            type="text"
            aria-label="Message input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about pull requests, repo metadata, or open an issue..."
            className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!input.trim()}
            icon={<PaperPlaneRightIcon size={16} />}
          >
            Send
          </Button>
        </form>
      </div>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
