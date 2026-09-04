import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodexClientMessage,
  CodexOperationSnapshot,
  CodexServerMessage,
  CodexWorkspaceFile,
  KernelJson
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** One kernel event as the UI reads it. */
export type KernelEvent = {
  seq: number;
  type: string;
  [key: string]: KernelJson;
};

type State = {
  readonly status: ConnectionStatus;
  /** Operations oldest first. */
  readonly operations: readonly CodexOperationSnapshot[];
  readonly events: Readonly<Record<string, readonly KernelEvent[]>>;
  readonly file: CodexWorkspaceFile | null;
  readonly error: string | undefined;
  /** True after a restart completes and the snapshot was reloaded. */
  readonly recovered: boolean;
};

const INITIAL_STATE: State = {
  status: "connecting",
  operations: [],
  events: {},
  file: null,
  error: undefined,
  recovered: false
};

function isKernelEvent(value: KernelJson): value is KernelEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.seq === "number" &&
    typeof value.type === "string"
  );
}

function upsert(
  operations: readonly CodexOperationSnapshot[],
  next: CodexOperationSnapshot
): CodexOperationSnapshot[] {
  const index = operations.findIndex(
    (operation) => operation.operationId === next.operationId
  );
  if (index === -1) return [...operations, next];
  const copy = [...operations];
  const previous = copy[index];
  copy[index] =
    next.checkpoint === null && previous?.checkpoint
      ? { ...next, checkpoint: previous.checkpoint, action: previous.action }
      : next;
  return copy;
}

function isActive(operation: CodexOperationSnapshot): boolean {
  return operation.status === "queued" || operation.status === "running";
}

/**
 * A live Codex session over the harness's WebSocket protocol, connected with
 * `useAgent`. The transcript and every operation's kernel events replay from
 * the Durable Object's durable state on connect and on every reconnect, so a
 * refresh mid-turn resumes where the last event left off.
 */
export function useCodexSession(session: string) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const restartingRef = useRef(false);
  /** Operations this connection already subscribed to; reset on every open. */
  const subscribedRef = useRef(new Set<string>());

  const agent = useAgent({
    agent: "coder",
    name: session,
    onOpen: () => {
      subscribedRef.current.clear();
      setState((current) => ({ ...current, status: "open" }));
    },
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: CodexServerMessage;
      try {
        message = JSON.parse(String(event.data)) as CodexServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "snapshot": {
          const { operations, file } = message.snapshot;
          const recovered = restartingRef.current;
          restartingRef.current = false;
          setState((current) => ({
            ...current,
            operations,
            file,
            recovered,
            error: undefined
          }));
          for (const operation of operations) {
            if (subscribedRef.current.has(operation.operationId)) continue;
            subscribedRef.current.add(operation.operationId);
            const from = stateEventsLength(operation.operationId);
            subscribeRef.current(operation.operationId, from);
          }
          return;
        }
        case "operation":
          setState((current) => ({
            ...current,
            operations: upsert(current.operations, message.operation)
          }));
          if (
            isActive(message.operation) &&
            !subscribedRef.current.has(message.operation.operationId)
          ) {
            subscribedRef.current.add(message.operation.operationId);
            subscribeRef.current(message.operation.operationId, 0);
          }
          return;
        case "events":
          setState((current) => {
            const existing = current.events[message.operationId] ?? [];
            const incoming = message.events
              .filter(isKernelEvent)
              .filter((event) =>
                existing.every((known) => known.seq !== event.seq)
              );
            if (incoming.length === 0) return current;
            return {
              ...current,
              events: {
                ...current.events,
                [message.operationId]: [...existing, ...incoming].sort(
                  (left, right) => left.seq - right.seq
                )
              }
            };
          });
          return;
        case "stream_end": {
          // Only an operation we were tailing live needs its settled state
          // and file; a replayed closed stream ends immediately.
          const operation = stateRef.current.operations.find(
            (candidate) => candidate.operationId === message.operationId
          );
          if (operation && isActive(operation)) {
            sendRef.current({ type: "snapshot", id: crypto.randomUUID() });
          }
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

  const send = useCallback(
    (message: CodexClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  const stateRef = useRef(state);
  stateRef.current = state;
  const stateEventsLength = (operationId: string): number =>
    stateRef.current.events[operationId]?.length ?? 0;

  const subscribe = useCallback(
    (operationId: string, from: number) =>
      send({ type: "subscribe", operationId, from }),
    [send]
  );
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => {
    setState(INITIAL_STATE);
  }, [session]);

  const submit = useCallback(
    (prompt: string) =>
      send({ type: "submit", id: crypto.randomUUID(), prompt }),
    [send]
  );

  /** Load one operation with its kernel checkpoint, which listings omit. */
  const inspect = useCallback(
    (operationId: string) =>
      send({ type: "operation", id: crypto.randomUUID(), operationId }),
    [send]
  );

  const restart = useCallback(() => {
    restartingRef.current = true;
    setState((current) => ({ ...current, recovered: false }));
    send({ type: "restart", id: crypto.randomUUID() });
  }, [send]);

  const active = state.operations.find(isActive) ?? null;

  return { ...state, active, submit, inspect, restart };
}
