import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import { Button, Surface, Text, Badge } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  WrenchIcon,
  InfoIcon,
  PlugsConnectedIcon
} from "@phosphor-icons/react";
import type { MCPServersState } from "agents";
import { nanoid } from "nanoid";
import "./styles.css";

let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("sessionId", sessionId);
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const agent = useAgent({
    agent: "chat",
    name: sessionId!,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onMcpUpdate: useCallback((mcpServers: MCPServersState) => {
      setMcpState(mcpServers);
    }, [])
  });

  const { messages, sendMessage, clearHistory } = useAgentChat({ agent });

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

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  const serverEntries = Object.entries(mcpState.servers);

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PlugsConnectedIcon
              size={22}
              className="text-kumo-accent"
              weight="bold"
            />
            <h1 className="text-lg font-semibold text-kumo-default">
              MCP RPC Transport
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
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  RPC Transport Demo
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This Agent connects to an McpAgent in the same Worker via
                    RPC — no HTTP, no network. The MCP server exposes a counter
                    tool and a whoami tool. Try asking the AI to add numbers or
                    check who you are.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {serverEntries.length > 0 && (
            <div className="flex items-center gap-2">
              <WrenchIcon
                size={16}
                weight="bold"
                className="text-kumo-subtle"
              />
              <span className="text-kumo-subtle">
                <Text size="xs" variant="secondary">
                  {mcpState.tools.length} tool
                  {mcpState.tools.length !== 1 ? "s" : ""} from{" "}
                  {serverEntries.length} RPC server
                  {serverEntries.length !== 1 ? "s" : ""}
                </Text>
              </span>
              {serverEntries.map(([id, server]) => (
                <Badge
                  key={id}
                  variant={server.state === "ready" ? "primary" : "secondary"}
                >
                  {server.name}
                </Badge>
              ))}
            </div>
          )}

          {messages.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <span className="block text-kumo-subtle">
                  <Text size="sm" variant="secondary">
                    Send a message to start chatting
                  </Text>
                </span>
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
                      ? "bg-kumo-accent text-white"
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
                    ?.filter((part) => part.type === "tool-invocation")
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
                        {"toolInvocation" in part
                          ? (
                              part.toolInvocation as {
                                toolName: string;
                              }
                            ).toolName
                          : "tool"}
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
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
          <PoweredByAgents />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
