/**
 * Read-only thread UI for agent-think.
 *
 * gh-app posts a link like `/thread/<repo>-<issue>` on the issue. This
 * SPA reads the session slug from the path, connects to that
 * ThinkAgent Durable Object over the agents WebSocket, and renders the
 * live message stream — assistant text, tool calls, and results — as
 * the agent reproduces or fixes the issue. It is a viewer: there is no
 * input box, because the run is driven by the GitHub command, not the
 * browser.
 */

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** `/thread/<session>` → `<session>`. */
function sessionFromPath(): string | null {
  const m = window.location.pathname.match(/^\/thread\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  const label =
    status === "connected"
      ? "live"
      : status === "connecting"
        ? "connecting…"
        : "disconnected";
  return (
    <span className={`status status--${status}`}>
      <span className="status__dot" />
      {label}
    </span>
  );
}

function ToolPart({ part }: { part: Record<string, unknown> }) {
  const name = getToolName(part as never);
  const state = part.state as string;
  const input = part.input as Record<string, unknown> | undefined;
  const output = part.output as unknown;
  const errorText = part.errorText as string | undefined;
  const running = state === "input-available" || state === "input-streaming";
  return (
    <div className={`tool ${state === "output-error" ? "tool--error" : ""}`}>
      <div className="tool__head">
        <span className={`tool__spinner ${running ? "spin" : ""}`}>⚙</span>
        <span className="tool__name">
          {running ? `running ${name}…` : name}
        </span>
        <span className="tool__state">{state}</span>
      </div>
      {input != null && (
        <pre className="tool__block">{JSON.stringify(input, null, 2)}</pre>
      )}
      {errorText && (
        <pre className="tool__block tool__block--error">{errorText}</pre>
      )}
      {output != null && (
        <pre className="tool__block">
          {typeof output === "string"
            ? output
            : JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}

function App() {
  const session = sessionFromPath();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    // Kebab-case of the DO class name `ThinkAgent`.
    agent: "think-agent",
    name: session ?? "unknown",
    onOpen: () => setStatus("connected"),
    onClose: () => setStatus("disconnected")
  });

  const { messages } = useAgentChat({ agent });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!session) {
    return (
      <div className="app">
        <div className="empty">
          No thread in the URL. Expected /thread/&lt;session&gt;.
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header__title">
          <span className="logo">◆</span> agent-think
          <span className="header__session">{session}</span>
        </div>
        <StatusDot status={status} />
      </header>

      <main className="thread">
        {messages.length === 0 && (
          <div className="empty">Waiting for the agent to start…</div>
        )}

        {messages.map((message) => {
          if (message.role === "user") {
            // The kickoff instruction — show it as the thread's task.
            return (
              <div key={message.id} className="msg msg--task">
                <div className="msg__label">task</div>
                <div className="msg__body">{messageText(message)}</div>
              </div>
            );
          }
          return (
            <div key={message.id} className="msg msg--assistant">
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  const text = (part as { text: string }).text;
                  if (!text) return null;
                  return (
                    <div key={i} className="msg__body">
                      {text}
                    </div>
                  );
                }
                if (part.type === "reasoning") {
                  const text = (part as { text: string }).text;
                  if (!text) return null;
                  return (
                    <div key={i} className="reasoning">
                      {text}
                    </div>
                  );
                }
                if (isToolUIPart(part)) {
                  return (
                    <ToolPart
                      key={i}
                      part={part as unknown as Record<string, unknown>}
                    />
                  );
                }
                return null;
              })}
            </div>
          );
        })}
        <div ref={endRef} />
      </main>

      <footer className="footer">
        read-only view · driven by the GitHub command · powered by Cloudflare
        Workers
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
