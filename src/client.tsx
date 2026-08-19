import { useState } from "react";
import { createRoot } from "react-dom/client";

type WireFrame = {
  type?: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  messages?: ChatMessage[];
};

type ChatMessage = {
  id?: string;
  role?: string;
  parts?: Array<Record<string, unknown>>;
};

type Diagnostic = {
  expectedReply: string;
  liveCache: ChatMessage[];
  rawCachedMessages?: ChatMessage[];
  sameReference?: boolean;
  durableHistory: ChatMessage[];
};

type Result = {
  reproduced: boolean;
  session: string;
  streamedText: string;
  reconnectSnapshot: ChatMessage[];
  getMessages: ChatMessage[];
  diagnostic: Diagnostic;
};

const CHAT_MESSAGES = "cf_agent_chat_messages";
const CHAT_REQUEST = "cf_agent_use_chat_request";
const CHAT_RESPONSE = "cf_agent_use_chat_response";

function socketUrl(session: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/agents/repro-think/${encodeURIComponent(session)}`;
}

function agentPath(session: string): string {
  return `/agents/repro-think/${encodeURIComponent(session)}`;
}

function parseFrame(event: MessageEvent): WireFrame | null {
  try {
    return JSON.parse(String(event.data)) as WireFrame;
  } catch {
    return null;
  }
}

function connectAndReadSnapshot(
  session: string,
  log: (message: string) => void,
  label: string
): Promise<{ socket: WebSocket; snapshot: ChatMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(session));
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error(`${label}: timed out waiting for the connect snapshot`));
    }, 12_000);

    socket.addEventListener("open", () => log(`${label}: WebSocket opened`));
    socket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error(`${label}: WebSocket error`));
    });
    socket.addEventListener("message", (event) => {
      const frame = parseFrame(event);
      if (frame?.type !== CHAT_MESSAGES || !Array.isArray(frame.messages)) return;
      window.clearTimeout(timeout);
      log(`${label}: connect snapshot has ${frame.messages.length} message(s)`);
      resolve({ socket, snapshot: frame.messages });
    });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2_000);
    socket.addEventListener(
      "close",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    socket.close(1000, "reconnect at stream end");
  });
}

function runTurn(
  socket: WebSocket,
  log: (message: string) => void
): Promise<string> {
  const requestId = crypto.randomUUID();
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Please reproduce issue 2132." }]
  };

  return new Promise((resolve, reject) => {
    let streamedText = "";
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the deterministic turn"));
    }, 20_000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      const frame = parseFrame(event);
      if (frame?.type !== CHAT_RESPONSE || frame.id !== requestId) return;

      if (frame.body?.trim()) {
        try {
          const chunk = JSON.parse(frame.body) as Record<string, unknown>;
          log(`stream chunk: ${String(chunk.type ?? "unknown")}`);
          if (chunk.type === "text-delta") {
            const delta = chunk.delta ?? chunk.textDelta ?? chunk.text;
            if (typeof delta === "string") streamedText += delta;
          }
        } catch {
          log("stream chunk: malformed JSON");
        }
      }

      if (frame.error) {
        cleanup();
        reject(new Error(frame.body || "stream returned an error"));
      } else if (frame.done) {
        cleanup();
        log(`stream done; rendered assistant text: ${JSON.stringify(streamedText)}`);
        resolve(streamedText);
      }
    };

    socket.addEventListener("message", onMessage);
    socket.send(
      JSON.stringify({
        type: CHAT_REQUEST,
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [userMessage],
            trigger: "submit-message"
          })
        }
      })
    );
    log("sent one chat turn to the deterministic model");
  });
}

function hasAssistant(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === "assistant");
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

function App() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = (message: string) =>
    setLog((current) => [
      ...current,
      `${new Date().toISOString()} ${message}`
    ]);

  const trigger = async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    setLog([]);
    const session = `issue-2132-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    let firstSocket: WebSocket | undefined;
    let secondSocket: WebSocket | undefined;

    try {
      add(`using fresh Durable Object ${session}`);
      const first = await connectAndReadSnapshot(session, add, "initial connection");
      firstSocket = first.socket;
      const streamedText = await runTurn(firstSocket, add);

      // Think broadcasts done before persisting the assistant. Drop this socket
      // at that boundary, then reconnect after persistence has had time to end.
      add("closing the socket immediately after the done frame");
      await closeSocket(firstSocket);
      firstSocket = undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));

      const second = await connectAndReadSnapshot(session, add, "reconnection");
      secondSocket = second.socket;
      const base = agentPath(session);
      const [getMessages, diagnostic] = await Promise.all([
        fetchJson<ChatMessage[]>(`${base}/get-messages`),
        fetchJson<Diagnostic>(`${base}/diagnostic`)
      ]);

      add(`/get-messages returned ${getMessages.length} message(s)`);
      add(`durable Session history has ${diagnostic.durableHistory.length} message(s)`);

      const reproduced =
        streamedText.includes(diagnostic.expectedReply) &&
        !hasAssistant(second.snapshot) &&
        !hasAssistant(getMessages) &&
        !hasAssistant(diagnostic.liveCache) &&
        hasAssistant(diagnostic.durableHistory);

      add(
        reproduced
          ? "REPRODUCED: streamed reply is durable but absent from every cache-backed recovery surface"
          : "NOT REPRODUCED: one or more recovery surfaces already contained the assistant"
      );
      setResult({
        reproduced,
        session,
        streamedText,
        reconnectSnapshot: second.snapshot,
        getMessages,
        diagnostic
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      add(`ERROR: ${message}`);
      setError(message);
    } finally {
      if (firstSocket) await closeSocket(firstSocket);
      if (secondSocket) await closeSocket(secondSocket);
      setRunning(false);
    }
  };

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", maxWidth: 980, margin: "0 auto", padding: 24 }}>
      <h1>#2132 — Think reply vanishes after reconnect at stream end</h1>
      <p>
        <strong>Expected:</strong> the assistant shown by the stream remains in the reconnect snapshot and
        <code> /get-messages</code>. <strong>Actual:</strong> both cache-backed reads omit it even though the
        Session row is durable.
      </p>
      <button onClick={trigger} disabled={running} style={{ padding: "10px 16px", fontWeight: 700 }}>
        {running ? "Running…" : "Trigger bug"}
      </button>
      {result && (
        <h2 style={{ color: result.reproduced ? "#b42318" : "#067647" }}>
          {result.reproduced ? "❌ Reproduced" : "✅ Could not reproduce"}
        </h2>
      )}
      {error && <p style={{ color: "#b42318" }}>Error: {error}</p>}
      <h2>Event log</h2>
      <pre style={{ whiteSpace: "pre-wrap", background: "#f4f4f5", padding: 16, minHeight: 180 }}>
        {log.join("\n") || "Press Trigger bug. The page streams one deterministic turn, closes at done, reconnects, and compares cache with storage."}
      </pre>
      {result && (
        <>
          <h2>Expected vs. actual data</h2>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f4f4f5", padding: 16 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
