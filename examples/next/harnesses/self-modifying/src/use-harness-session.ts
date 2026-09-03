import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  HarnessClientMessage,
  HarnessServerMessage,
  HarnessSnapshot,
  HarnessTurn,
  JsonObject
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** One turn event as the UI reads it. */
export type TurnEvent = JsonObject & { readonly seq: number };

type State = {
  readonly status: ConnectionStatus;
  readonly snapshot: HarnessSnapshot | null;
  readonly events: Readonly<Record<string, readonly TurnEvent[]>>;
  readonly error: string | undefined;
};

const INITIAL_STATE: State = {
  status: "connecting",
  snapshot: null,
  events: {},
  error: undefined
};

function upsertTurn(snapshot: HarnessSnapshot, next: HarnessTurn) {
  const index = snapshot.turns.findIndex((turn) => turn.turnId === next.turnId);
  const turns = [...snapshot.turns];
  if (index === -1) turns.push(next);
  else turns[index] = next;
  return { ...snapshot, turns };
}

function isActive(turn: HarnessTurn): boolean {
  return turn.state === "queued" || turn.state === "running";
}

/**
 * A live self-modifying harness object over its WebSocket protocol,
 * connected with `useAgent`. The object snapshot and every turn's events
 * replay from durable state on connect and on every reconnect.
 */
export function useHarnessSession(name: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const agent = useAgent({
    agent: "self-modifying-harness",
    name,
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: HarnessServerMessage;
      try {
        message = JSON.parse(String(event.data)) as HarnessServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "snapshot":
          setState((current) => ({
            ...current,
            snapshot: message.snapshot,
            error: undefined
          }));
          for (const turn of message.snapshot.turns) {
            const from = stateRef.current.events[turn.turnId]?.length ?? 0;
            subscribeRef.current(turn.turnId, from);
          }
          return;
        case "turn":
          setState((current) => ({
            ...current,
            snapshot: current.snapshot
              ? upsertTurn(current.snapshot, message.turn)
              : current.snapshot
          }));
          if (isActive(message.turn)) {
            subscribeRef.current(message.turn.turnId, 0);
          }
          return;
        case "events":
          setState((current) => {
            const existing = current.events[message.turnId] ?? [];
            let seq = message.seq;
            const incoming: TurnEvent[] = [];
            for (const event of message.events) {
              const numbered = { ...event, seq: seq++ };
              if (existing.every((known) => known.seq !== numbered.seq)) {
                incoming.push(numbered);
              }
            }
            if (incoming.length === 0) return current;
            return {
              ...current,
              events: {
                ...current.events,
                [message.turnId]: [...existing, ...incoming].sort(
                  (left, right) => left.seq - right.seq
                )
              }
            };
          });
          return;
        case "stream_end":
          sendRef.current({ type: "snapshot", id: crypto.randomUUID() });
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  const send = useCallback(
    (message: HarnessClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  const subscribe = useCallback(
    (turnId: string, from: number) => send({ type: "subscribe", turnId, from }),
    [send]
  );
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => {
    setState(INITIAL_STATE);
  }, [name]);

  const submit = useCallback(
    (prompt: string) =>
      send({ type: "submit", id: crypto.randomUUID(), prompt }),
    [send]
  );

  const restore = useCallback(
    (revisionId: number) =>
      send({ type: "restore", id: crypto.randomUUID(), revisionId }),
    [send]
  );

  const dismissError = useCallback(
    () => setState((current) => ({ ...current, error: undefined })),
    []
  );

  const active = state.snapshot?.turns.find(isActive) ?? null;

  return { ...state, active, submit, restore, dismissError };
}
