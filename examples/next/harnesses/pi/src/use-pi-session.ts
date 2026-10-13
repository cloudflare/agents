import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PiCommandOutbox } from "./outbox";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  SessionView,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: []
};

/**
 * One pi session over the harness's WebSocket protocol, connected with
 * `useAgent`. The server sends pi's own agent events; this folds them with
 * the same `reduceEvents` the server tests use. A reconnect gets a fresh
 * snapshot, and the client sends again every submit it has not seen
 * answered; the server deduplicates them by operation id.
 */
export function usePiSession(object: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  // Submits not yet answered, sent again whenever the socket opens.
  const outbox = useRef(new PiCommandOutbox());
  const socket = useRef<{ send(data: string): void } | null>(null);

  const agent = useAgent({
    agent: "pi-agent",
    name: object,
    onOpen: () => {
      setState((current) => ({ ...current, status: "open" }));
      for (const command of outbox.current.pending()) {
        socket.current?.send(JSON.stringify(command));
      }
    },
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      outbox.current.receive(message);
      switch (message.type) {
        case "hello":
          setState((current) => ({ ...current, catalog: message.tools }));
          return;
        case "events":
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events)
          }));
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  socket.current = agent;

  useEffect(() => {
    setState(INITIAL_STATE);
    outbox.current = new PiCommandOutbox();
  }, [object]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run.
   * While the socket is closed the submit waits in the outbox, and goes out
   * when it opens.
   */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") =>
      send(outbox.current.submit(text, whenBusy)),
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  const reset = useCallback(
    () => send({ type: "reset", id: crypto.randomUUID() }),
    [send]
  );

  return { ...state, submit, abort, reset };
}
