import { useCallback, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useAgentChat, type AITool } from "agents/chat/react";
import { useAgent } from "agents/react";
import "./styles.css";

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type DemoMode = "client-tool" | "rich" | "interrupted";

const browserTools = {
  describeBrowser: {
    description: "Return non-sensitive context about this browser",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The user's request" }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    execute: async (input: unknown) => ({
      prompt:
        typeof input === "object" && input !== null && "prompt" in input
          ? String(input.prompt)
          : "",
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  }
} satisfies Record<string, AITool>;

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function reasoningOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

function sourcesOf(message: UIMessage) {
  return message.parts.filter((part) => part.type === "source-url");
}

function App() {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("Show me the Web Channel");
  const [mode, setMode] = useState<DemoMode>("client-tool");
  const objectName = useMemo(
    () =>
      new URLSearchParams(window.location.search).get("conversation") ??
      "react-demo-shared",
    []
  );
  const participantId = useMemo(() => {
    const key = "web-channel-demo-participant";
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);
    return created;
  }, []);

  const agent = useAgent({
    agent: "WebChannelLiveObject",
    name: objectName,
    basePath: "chat",
    query: {
      name: objectName,
      conversationId: objectName,
      participantId
    },
    onOpen: useCallback(() => setConnection("connected"), []),
    onClose: useCallback(() => setConnection("disconnected"), [])
  });

  const { messages, sendMessage, status, stop, clearHistory, error } =
    useAgentChat({
      agent,
      body: () => ({
        demo: mode === "client-tool" ? "client-tool" : "rich",
        interrupt: mode === "interrupted"
      }),
      tools: browserTools,
      onToolCall: async ({ toolCall, addToolOutput }) => {
        if (toolCall.toolName !== "describeBrowser") {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: null,
            state: "output-error",
            errorText: `Unknown client tool: ${toolCall.toolName}`
          });
          return;
        }
        const output = await browserTools.describeBrowser.execute(
          toolCall.input
        );
        addToolOutput({ toolCallId: toolCall.toolCallId, output });
      },
      resume: false,
      syncMessagesToServer: false
    });

  const busy = status === "submitted" || status === "streaming";

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || connection !== "connected") return;
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  function reset() {
    if (busy) void stop();
    clearHistory();
  }

  return (
    <main>
      <header>
        <p className="eyebrow">Local compatibility fixture</p>
        <h1>Web Channel through React hooks</h1>
        <p>
          This page uses <code>useAgent</code> and <code>useAgentChat</code>{" "}
          from the local Agents build. Open it in a second tab to observe the
          same live conversation. The response is deterministic and does not
          call a model.
        </p>
        <dl>
          <div>
            <dt>Socket</dt>
            <dd data-status={connection}>{connection}</dd>
          </div>
          <div>
            <dt>Chat</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Chat error</dt>
            <dd>{error?.message ?? "none"}</dd>
          </div>
          <div>
            <dt>Agent identity</dt>
            <dd>{agent.identified ? "identified" : "not implemented"}</dd>
          </div>
        </dl>
      </header>

      <section className="transcript" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty">Send a message to start the rich stream.</p>
        ) : (
          messages.map((message) => {
            const reasoning = reasoningOf(message);
            const sources = sourcesOf(message);
            return (
              <article key={message.id} className={message.role}>
                <strong>{message.role === "user" ? "You" : "Channel"}</strong>
                {reasoning && (
                  <details open>
                    <summary>Reasoning</summary>
                    <p>{reasoning}</p>
                  </details>
                )}
                {message.parts.filter(isToolUIPart).map((part) => (
                  <p className="tool" key={part.toolCallId}>
                    Client tool {getToolName(part)}: {part.state}
                  </p>
                ))}
                <p>
                  {textOf(message) || (message.role === "assistant" ? "…" : "")}
                </p>
                {sources.length > 0 && (
                  <ul>
                    {sources.map((source) => (
                      <li key={source.sourceId}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title ?? source.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })
        )}
      </section>

      <form onSubmit={submit}>
        <label htmlFor="prompt">Message</label>
        <textarea
          id="prompt"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
        />
        <label htmlFor="mode">Demo path</label>
        <select
          id="mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as DemoMode)}
        >
          <option value="client-tool">Client tool and continuation</option>
          <option value="rich">Rich stream</option>
          <option value="interrupted">Interrupted rich stream</option>
        </select>
        <div className="actions">
          <button type="submit" disabled={busy || connection !== "connected"}>
            Send
          </button>
          <button type="button" onClick={() => void stop()} disabled={!busy}>
            Stop
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={messages.length === 0}
          >
            Reset conversation
          </button>
        </div>
      </form>

      <aside>
        Canonical conversation history is persisted and restored after reload.
        In-flight reconnect replay, Agent identity/state, and ordinary Agent RPC
        are deliberately disabled or not implemented in this fixture.
      </aside>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<App />);
