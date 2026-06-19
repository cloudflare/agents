/**
 * Minimal React `useChat` demo for the TanStack AI recovery harness.
 *
 * Drives the REAL `@tanstack/ai-react` `useChat` over the custom
 * {@link createRecoveryConnection} WebSocket adapter (the `cf_agent_* <-> AG-UI`
 * bridge). Open two tabs, send a message, then refresh one mid-stream: the
 * shared `ResumeHandshake` replays the buffered partial to the reconnecting tab.
 * Kill `wrangler dev` mid-stream and restart to watch fiber recovery continue
 * the turn. This is a manual companion to the headless SIGKILL e2e — the e2e is
 * the authoritative proof.
 *
 * @internal Validation fixture, not a published package.
 */

import { useChat } from "@tanstack/ai-react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UIMessage } from "@tanstack/ai-client";
import { createRecoveryConnection } from "./ws-adapter";

function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.content : ""))
    .join("");
}

function App() {
  const session = useMemo(() => {
    const param = new URLSearchParams(window.location.search).get("session");
    return param ?? "demo";
  }, []);
  const connection = useMemo(
    () => createRecoveryConnection(window.location.origin, session),
    [session]
  );
  const { messages, sendMessage, isLoading, connectionStatus } = useChat({
    connection,
    live: true
  });
  const [input, setInput] = useState("recover me");

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "2rem auto",
        padding: "0 1rem"
      }}
    >
      <h1>TanStack AI recovery harness</h1>
      <p style={{ color: "#666" }}>
        session <code>{session}</code> · connection{" "}
        <strong>{connectionStatus}</strong>
      </p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {messages.map((message) => (
          <li
            key={message.id}
            style={{
              padding: "0.5rem 0.75rem",
              margin: "0.5rem 0",
              borderRadius: 8,
              background: message.role === "user" ? "#eef" : "#efe"
            }}
          >
            <strong>{message.role}:</strong> {messageText(message)}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim()) return;
          void sendMessage(input);
          setInput("");
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          style={{ flex: 1, padding: "0.5rem" }}
        />
        <button type="submit" disabled={isLoading}>
          Send
        </button>
      </form>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
