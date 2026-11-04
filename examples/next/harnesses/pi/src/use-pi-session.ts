import type { EntryId } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PiSessionMirror } from "./mirror";
import { PiCommandOutbox } from "./outbox";
import { EMPTY_VIEW } from "./view";
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
  /** A page of earlier or missing messages is loading. */
  readonly loading: boolean;
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: [],
  loading: false
};

/**
 * One pi session over the harness's WebSocket protocol, connected with
 * `useAgent`. Each time the socket opens, the client asks to watch the
 * session; `PiSessionMirror` applies the server's view and operations,
 * keeps the whole transcript the client has seen, and projects it with the
 * same `projectView` the server tests use. A reconnect resumes after the
 * newest entry the client has. The client sends again every submit whose
 * answer the socket never delivered; the harness deduplicates them by
 * operation id, so each runs once.
 */
export function usePiSession(object: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  // Unanswered submits, sent again each time the socket opens.
  const [outbox] = useState(() => new PiCommandOutbox());
  // The session as the client has it. Another object starts from a clean
  // slate.
  const [mirrored, setMirrored] = useState(() => ({
    object,
    mirror: createMirror(setState)
  }));
  let mirror = mirrored.mirror;
  if (mirrored.object !== object) {
    mirror = createMirror(setState);
    setMirrored({ object, mirror });
    setState(INITIAL_STATE);
  }

  const agent = useAgent({
    agent: "pi-agent",
    name: object,
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => {
      mirror.close();
      setState((current) => ({ ...current, status: "closed" }));
    },
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      outbox.receive(message);
      mirror.receive(message);
      switch (message.type) {
        case "hello":
          setState((current) => ({ ...current, catalog: message.tools }));
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
    // Submits belong to the last object's session.
    outbox.clear();
  }, [object, outbox]);

  // The last object's mirror stops loading pages.
  const currentMirror = useRef(mirror);
  useEffect(() => {
    currentMirror.current = mirror;
    return () => mirror.close();
  }, [mirror]);

  useEffect(() => {
    if (state.status !== "open") return;
    mirror.open((message) => agent.send(JSON.stringify(message)));
    outbox.sendPending((data) => agent.send(data));
  }, [state.status, agent, mirror, outbox]);

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

  /** Run one page load of this object's mirror, showing `loading` meanwhile. */
  const load = useCallback(
    (loading: Promise<void>) => {
      const update = (change: (current: State) => State) => {
        // Another object's state took this one's place.
        if (currentMirror.current === mirror) setState(change);
      };
      update((current) => ({ ...current, loading: true }));
      loading
        // The server's `error` frame shows its failure; a dropped socket
        // shows as the connection status, and the user can try again.
        .catch(() => {})
        .finally(() => update((current) => ({ ...current, loading: false })));
    },
    [mirror]
  );

  /** Load the page of messages before the oldest one shown. */
  const loadEarlier = useCallback(
    () => load(mirror.loadEarlier()),
    [load, mirror]
  );

  /** Load the next page of messages a `gap` message stands for. */
  const fillGap = useCallback(
    (gap: { after: EntryId; upTo: EntryId }) => load(mirror.fillGap(gap)),
    [load, mirror]
  );

  return { ...state, submit, abort, reset, loadEarlier, fillGap };
}

function createMirror(
  setState: (update: (current: State) => State) => void
): PiSessionMirror {
  return new PiSessionMirror((view) =>
    setState((current) => ({ ...current, ...view }))
  );
}
