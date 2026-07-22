import {
  StrictMode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";

const MARKER = "already streamed";

type Phase =
  | "idle"
  | "starting"
  | "waiting-live"
  | "awaiting-replay"
  | "reproduced"
  | "not-seen";

function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function App() {
  // Every page load gets an untouched Durable Object, which keeps the repro
  // repeatable without adding reset machinery to the backend.
  const room = useMemo(() => `run-${crypto.randomUUID()}`, []);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [connection, setConnection] = useState("connecting");
  const [ackCount, setAckCount] = useState(0);
  const [replayStarts, setReplayStarts] = useState(0);
  const [replayCompletes, setReplayCompletes] = useState(0);
  const [beforeReconnect, setBeforeReconnect] = useState("");
  const [duplicateSnapshot, setDuplicateSnapshot] = useState("");
  const didReconnect = useRef(false);
  const connectedOnce = useRef(false);
  const canTrigger = connection === "connected";
  const agentSocketRef = useRef<{ reconnect(): void } | null>(null);
  const forceReconnect = useCallback(() => {
    agentSocketRef.current?.reconnect();
  }, []);

  const add = useCallback((message: string) => {
    setLog((entries) => [
      ...entries,
      `${new Date().toISOString()} ${message}`
    ]);
  }, []);

  const inspectIncoming = useCallback(
    (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const frame = JSON.parse(event.data) as {
          type?: string;
          body?: string;
          replay?: boolean;
          replayComplete?: boolean;
        };
        if (frame.type === "cf_agent_stream_resuming") {
          add("recv STREAM_RESUMING");
        }
        if (
          frame.type === "cf_agent_use_chat_response" &&
          frame.replay === true
        ) {
          if (frame.body) {
            const chunk = JSON.parse(frame.body) as { type?: string };
            if (chunk.type === "start") {
              setReplayStarts((count) => count + 1);
              add("recv replayed continuation start");
            }
          }
          if (frame.replayComplete) {
            setReplayCompletes((count) => count + 1);
            add("recv replayComplete");
          }
        }
      } catch {
        // Ignore non-protocol messages.
      }
    },
    [add]
  );

  const agent = useAgent({
    agent: "repro-chat",
    name: room,
    onOpen: () => {
      connectedOnce.current = true;
      setConnection("connected");
      add("WebSocket open");
    },
    onClose: () => {
      setConnection("closed/reconnecting");
      add("WebSocket close");
    },
    onMessage: inspectIncoming
  });
  agentSocketRef.current = agent;

  // Count outgoing resume ACKs. This is observation only; the original send is
  // called unchanged. The issue reproduces with one ACK and one replay batch.
  useEffect(() => {
    const socket = agent as unknown as {
      send(data: unknown): void;
    };
    const originalSend = socket.send;
    socket.send = function observedSend(data: unknown) {
      if (typeof data === "string") {
        try {
          const frame = JSON.parse(data) as { type?: string };
          if (frame.type === "cf_agent_stream_resume_ack") {
            setAckCount((count) => count + 1);
            add("send STREAM_RESUME_ACK");
          }
        } catch {
          // Ignore non-JSON sends.
        }
      }
      return originalSend.call(agent, data);
    };
    return () => {
      socket.send = originalSend;
    };
  }, [agent, add]);

  const { messages, status } = useAgentChat({
    agent,
    resume: true,
    // This page uses a fresh room and receives the baseline broadcast from
    // /trigger, so no mount-time HTTP hydration is needed.
    getInitialMessages: null
  });

  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant") as UIMessage | undefined;
  const assistantText = textOf(assistant);
  const markerCount = occurrences(assistantText, MARKER);

  // As soon as live continuation bytes are visible, force exactly one real
  // PartySocket reconnect while the server keeps that continuation open.
  useEffect(() => {
    if (
      didReconnect.current ||
      markerCount !== 1 ||
      (phase !== "starting" && phase !== "waiting-live")
    ) {
      return;
    }

    didReconnect.current = true;
    setBeforeReconnect(assistantText);
    setPhase("awaiting-replay");
    add(`live suffix rendered once: ${JSON.stringify(assistantText)}`);
  }, [add, assistantText, markerCount, phase]);

  useEffect(() => {
    if (phase !== "awaiting-replay") return;
    const timer = window.setTimeout(() => {
      add("forcing WebSocket reconnect while continuation is active");
      // useAgent's async query refresh is the issue's deterministic reconnect
      // source; PartySocket.reconnect() produces the same close→open resume
      // handshake without waiting for the five-minute cache TTL.
      forceReconnect();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [add, forceReconnect, phase]);

  // Capture the transient duplicate before the server's authoritative final
  // message can replace it at stream completion.
  useEffect(() => {
    if (markerCount < 2 || duplicateSnapshot) return;
    setDuplicateSnapshot(assistantText);
    setPhase("reproduced");
    add(`BUG: suffix rendered ${markerCount} times after one replay`);
  }, [add, assistantText, duplicateSnapshot, markerCount]);

  // Give a clear fallback result if a browser/version does not exhibit it.
  useEffect(() => {
    if (phase !== "awaiting-replay") return;
    const timer = window.setTimeout(() => {
      setPhase((current) =>
        current === "awaiting-replay" ? "not-seen" : current
      );
    }, 7_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const trigger = useCallback(async () => {
    if (phase !== "idle" || !connectedOnce.current) return;
    setPhase("starting");
    add("POST trigger: seed completed step + start continuation");
    try {
      const response = await fetch(
        `/agents/repro-chat/${encodeURIComponent(room)}/trigger`,
        { method: "POST" }
      );
      if (!response.ok) {
        throw new Error(`${response.status}: ${await response.text()}`);
      }
      add(`trigger accepted: ${await response.text()}`);
      setPhase((current) =>
        current === "starting" ? "waiting-live" : current
      );
    } catch (error) {
      add(`trigger failed: ${error instanceof Error ? error.message : error}`);
      setPhase("not-seen");
    }
  }, [add, phase, room]);

  const verdict = duplicateSnapshot
    ? "BUG REPRODUCED"
    : phase === "not-seen"
      ? "DUPLICATE NOT OBSERVED"
      : phase === "idle"
        ? "READY"
        : "RUNNING";

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 960,
        margin: "0 auto",
        padding: 24,
        lineHeight: 1.45
      }}
    >
      <h1>#1951: continuation replay duplication</h1>
      <p>
        <strong>Expected:</strong> the continuation suffix “{MARKER}” appears
        once after reconnect. <strong>Actual bug:</strong> one legitimate replay
        appends it a second time while preserving the earlier assistant parts.
      </p>

      <button
        id="trigger"
        onClick={trigger}
        disabled={phase !== "idle" || !canTrigger}
        style={{ font: "inherit", padding: "8px 14px", cursor: "pointer" }}
      >
        {canTrigger ? "Trigger bug" : "Connecting…"}
      </button>

      <section
        style={{
          marginTop: 20,
          padding: 16,
          border: "2px solid #777",
          borderColor: duplicateSnapshot ? "#c22" : "#777"
        }}
      >
        <h2 style={{ marginTop: 0 }}>Visible result</h2>
        <output
          id="verdict"
          data-verdict={duplicateSnapshot ? "reproduced" : phase}
          style={{
            display: "block",
            fontWeight: 700,
            color: duplicateSnapshot ? "#c22" : "inherit"
          }}
        >
          {verdict}
        </output>
        <div>Connection: {connection}</div>
        <div>AI SDK chat status: {status}</div>
        <div>Marker occurrences now: {markerCount}</div>
        <div>Resume ACKs observed: {ackCount}</div>
        <div>Replayed start chunks observed: {replayStarts}</div>
        <div>Replay-complete frames observed: {replayCompletes}</div>
      </section>

      <h2>Assistant text</h2>
      <pre id="assistant-text" style={{ whiteSpace: "pre-wrap" }}>
        {assistantText || "(none yet)"}
      </pre>

      <h2>Captured evidence</h2>
      <pre id="evidence" style={{ whiteSpace: "pre-wrap" }}>
        {duplicateSnapshot
          ? `Before reconnect:\n${beforeReconnect}\n\nAfter one replay:\n${duplicateSnapshot}`
          : "Waiting for duplicate snapshot…"}
      </pre>

      <h2>Event log</h2>
      <pre id="log" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
        {log.join("\n")}
      </pre>
      <small>Room: {room}</small>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<main style={{ padding: 24 }}>Connecting…</main>}>
      <App />
    </Suspense>
  </StrictMode>
);
