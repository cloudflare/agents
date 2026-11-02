import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PiCommandOutbox } from "./outbox";
import { EMPTY_VIEW, projectView } from "./view";
import type {
  ClientMessage,
  ServerMessage,
  PiConversationView,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = PiConversationView & {
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
 * One pi conversation over the harness's WebSocket protocol, connected with
 * `useAgent`. The server sends pi's conversation view, then pi's operations
 * for each change; this applies them and projects the view with the same
 * `projectView` the server tests use. A reconnect gets the whole view
 * again, and the client sends again every submit whose answer the
 * socket never delivered; the harness deduplicates them by operation id, so
 * each runs once.
 */
export function usePiConversation(object: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  // Unanswered submits, sent again each time the socket opens.
  const [outbox] = useState(() => new PiCommandOutbox());
  // pi's view, as the server last sent it; the operations apply to it.
  const view = useRef<ConversationView | null>(null);
  // Another object starts from a clean slate.
  const [stateObject, setStateObject] = useState(object);
  if (stateObject !== object) {
    setStateObject(object);
    setState(INITIAL_STATE);
  }

  const agent = useAgent({
    agent: "pi-agent",
    name: object,
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      outbox.receive(message);
      switch (message.type) {
        case "hello":
          setState((current) => ({ ...current, catalog: message.tools }));
          return;
        case "view":
        case "ops": {
          if (message.type === "view") view.current = message.view;
          // Operations without a view to apply to: wait for the next view.
          else if (view.current === null) return;
          else view.current = applyImmutable(view.current, message.ops);
          const projected = projectView(view.current);
          setState((current) => ({ ...current, ...projected }));
          return;
        }
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    // Submits and the view belong to the last object's conversation.
    outbox.clear();
    view.current = null;
  }, [object, outbox]);

  useEffect(() => {
    if (state.status !== "open") return;
    outbox.sendPending((data) => agent.send(data));
  }, [state.status, agent, outbox]);

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
   * Kept in the outbox until answered, and sent again if the socket drops
   * first.
   */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") =>
      send(outbox.submit(text, whenBusy)),
    [send, outbox]
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
