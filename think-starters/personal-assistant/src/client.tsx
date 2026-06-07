import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import "./styles.css";

const STORAGE_KEY = "think-personal-assistant-session";

function getSessionId(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

type Status = "connecting" | "connected" | "disconnected";

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
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
    >
      {mode === "light" ? "Dark" : "Light"}
    </button>
  );
}

function Message({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    return (
      <div className="row user">
        <div className="bubble">{text}</div>
      </div>
    );
  }

  return (
    <>
      {message.parts.map((part, i) => {
        if (part.type === "text" && part.text) {
          return (
            <div className="row assistant" key={i}>
              <div className="bubble">{part.text}</div>
            </div>
          );
        }
        if (isToolUIPart(part)) {
          return (
            <div className="row assistant" key={i}>
              <div className="tool">
                {getToolName(part)}
                {part.state === "output-available" ? " ✓" : " …"}
              </div>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "assistant",
    name: getSessionId(),
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    stop,
    status: chatStatus
  } = useAgentChat({ agent });

  const isStreaming = chatStatus === "streaming" || chatStatus === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="app">
      <header className="header">
        <h1>Personal Assistant</h1>
        <div className="actions">
          <div className="status">
            <span className={`dot ${status}`} />
            {status}
          </div>
          <ModeToggle />
          <button type="button" onClick={() => clearHistory()}>
            Clear
          </button>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">Send a message to start chatting.</div>
        )}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={2}
          aria-label="Message"
          value={input}
          placeholder="Send a message…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {isStreaming ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
