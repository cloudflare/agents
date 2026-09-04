import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import type {
  ClientMessage,
  MessageDelta,
  ServerMessage,
  TranscriptEvent,
  TranscriptMessage,
  TranscriptPart,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = {
  readonly status: ConnectionStatus;
  readonly messages: readonly TranscriptMessage[];
  /** The assistant message currently being streamed, or null when idle. */
  readonly live: TranscriptMessage | null;
  readonly running: boolean;
  readonly runningTools: readonly string[];
  readonly tools: readonly ToolInfo[];
  readonly error: string | undefined;
};

const INITIAL_STATE: State = {
  status: "connecting",
  messages: [],
  live: null,
  running: false,
  runningTools: [],
  tools: [],
  error: undefined
};

function applyDelta(
  message: TranscriptMessage,
  delta: MessageDelta
): TranscriptMessage {
  if (delta.type === "start") return delta.message;
  const parts: TranscriptPart[] = [...message.parts];
  const previous = parts[delta.index];
  switch (delta.type) {
    case "text_start":
    case "text_end":
      parts[delta.index] = { type: "text", text: delta.text };
      break;
    case "text_delta":
      parts[delta.index] = {
        type: "text",
        text: (previous?.type === "text" ? previous.text : "") + delta.delta
      };
      break;
    case "thinking_start":
    case "thinking_end":
      parts[delta.index] = { type: "thinking", text: delta.text };
      break;
    case "thinking_delta":
      parts[delta.index] = {
        type: "thinking",
        text: (previous?.type === "thinking" ? previous.text : "") + delta.delta
      };
      break;
    case "toolcall_start":
    case "toolcall_end":
      parts[delta.index] = {
        type: "tool-call",
        id: delta.id,
        name: delta.name,
        arguments: delta.arguments
      };
      break;
    case "toolcall_checkpoint":
    case "toolcall_delta":
      // Partial tool-call JSON; the demo renders arguments once complete.
      break;
  }
  return { ...message, parts };
}

function reduce(state: State, event: TranscriptEvent): State {
  switch (event.type) {
    case "operation_start":
      return { ...state, running: true, error: undefined };
    case "operation_end":
      return {
        ...state,
        running: false,
        live: null,
        runningTools: [],
        ...(event.status === "failed" && event.error
          ? { error: event.error.message }
          : {})
      };
    case "message_start":
      return { ...state, live: event.message };
    case "message_delta":
      return state.live
        ? { ...state, live: applyDelta(state.live, event.delta) }
        : state;
    case "message":
      if (state.messages.some((known) => known.id === event.message.id)) {
        return state;
      }
      return {
        ...state,
        messages: [...state.messages, event.message],
        live:
          event.message.role === "assistant" && state.live ? null : state.live
      };
    case "tool_start":
      return {
        ...state,
        runningTools: [...state.runningTools, event.toolName]
      };
    case "tool_end": {
      const next = [...state.runningTools];
      const index = next.indexOf(event.toolName);
      if (index >= 0) next.splice(index, 1);
      return { ...state, runningTools: next };
    }
    case "fault":
      return { ...state, error: event.message };
    default:
      return state;
  }
}

/**
 * A live pi lane over the harness's WebSocket protocol, connected with
 * `useAgent`: a durable transcript plus a token-by-token streaming view of
 * the operation in flight. Replays from the server's own durable stream on
 * connect and on reconnect, so a refresh mid-turn resumes exactly where the
 * last chunk left off.
 */
export function usePiSession(session: string, lane = "main") {
  const [state, setState] = useState<State>(INITIAL_STATE);

  const agent = useAgent({
    agent: "pi-agent",
    name: session,
    query: { lane },
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "snapshot":
          setState((current) => ({
            ...current,
            messages: message.snapshot.messages,
            running: message.snapshot.operation !== null,
            runningTools:
              message.snapshot.operation?.runningTools.map(
                (tool) => tool.toolName
              ) ?? [],
            live: message.snapshot.operation?.streaming ?? null,
            tools: message.snapshot.tools
          }));
          if (message.snapshot.stream && message.snapshot.stream.cursor > 0) {
            const resume: ClientMessage = {
              type: "subscribe",
              streamId: message.snapshot.stream.streamId,
              from: message.snapshot.stream.cursor
            };
            agent.send(JSON.stringify(resume));
          }
          return;
        case "events":
          setState((current) =>
            message.events.reduce((next, event) => reduce(next, event), current)
          );
          // The durable transcript is authoritative at operation boundaries:
          // the user's prompt entry and the settled messages come from it.
          if (
            message.events.some(
              (event) =>
                event.type === "operation_start" ||
                event.type === "operation_end"
            )
          ) {
            agent.send(
              JSON.stringify({ type: "snapshot", id: crypto.randomUUID() })
            );
          }
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    setState(INITIAL_STATE);
  }, [session]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  const submit = useCallback(
    (prompt: string) =>
      send({
        type: "submit",
        id: crypto.randomUUID(),
        request: { kind: "prompt", prompt }
      }),
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  return { ...state, submit, abort };
}
