import type {
  OpenCodeMessage,
  OpenCodePendingOperation,
  OpenCodeSessionInfo
} from "agents/harness/opencode";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import type { ClientMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Text streamed into an assistant message that no snapshot has yet. */
export type LiveText = {
  readonly text: string;
  readonly reasoning: string;
};

type State = {
  readonly status: ConnectionStatus;
  readonly messages: readonly OpenCodeMessage[];
  readonly busy: boolean;
  readonly pending: readonly OpenCodePendingOperation[];
  readonly sessions: readonly OpenCodeSessionInfo[];
  /** Live deltas by assistant message id, until a snapshot catches up. */
  readonly live: Readonly<Record<string, LiveText>>;
  readonly error: string | undefined;
};

const INITIAL_STATE: State = {
  status: "connecting",
  messages: [],
  busy: false,
  pending: [],
  sessions: [],
  live: {},
  error: undefined
};

function textLength(message: OpenCodeMessage | undefined): number {
  if (message?.type !== "assistant") return 0;
  return message.content.reduce(
    (total, part) => total + (part.type === "text" ? part.text.length : 0),
    0
  );
}

/** Drop live text a snapshot has caught up with. */
function prune(
  live: State["live"],
  messages: readonly OpenCodeMessage[]
): State["live"] {
  const next: Record<string, LiveText> = {};
  for (const [id, text] of Object.entries(live)) {
    const message = messages.find((candidate) => candidate.id === id);
    const done =
      message?.type === "assistant" &&
      (message.time.completed !== undefined ||
        textLength(message) >= text.text.length);
    if (!done) next[id] = text;
  }
  return next;
}

/**
 * One OpenCode session over this app's WebSocket protocol, connected with
 * `useAgent`. Snapshots replace the transcript; OpenCode's text and
 * reasoning deltas stream into the assistant message they belong to until
 * the next snapshot has them.
 */
export function useOpenCodeSession(
  object: string,
  session: string,
  /** Called when the server does not know the session, such as a stale id. */
  onUnknownSession: () => void
) {
  const [state, setState] = useState<State>(INITIAL_STATE);

  const agent = useAgent({
    agent: "open-code-agent",
    name: object,
    query: { session },
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
        case "sessions":
          setState((current) => ({ ...current, sessions: message.sessions }));
          return;
        case "snapshot":
          if (message.session !== session) return;
          setState((current) => ({
            ...current,
            messages: message.messages,
            // Queued work starts as soon as the current run ends: keep
            // showing the session as busy between the two.
            busy: message.busy || message.pending.length > 0,
            pending: message.pending,
            live: prune(current.live, message.messages)
          }));
          return;
        case "event": {
          const { event: opencode } = message;
          if (
            opencode.type !== "session.text.delta" &&
            opencode.type !== "session.reasoning.delta"
          ) {
            return;
          }
          const id = opencode.data.assistantMessageID;
          const delta = opencode.data.delta;
          setState((current) => {
            const previous = current.live[id] ?? { text: "", reasoning: "" };
            return {
              ...current,
              busy: true,
              live: {
                ...current.live,
                [id]:
                  opencode.type === "session.text.delta"
                    ? { ...previous, text: previous.text + delta }
                    : { ...previous, reasoning: previous.reasoning + delta }
              }
            };
          });
          return;
        }
        case "error":
          if (message.code === "unknown_session") {
            onUnknownSession();
            return;
          }
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    setState(INITIAL_STATE);
  }, [object, session]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  /** Idle: starts a run. Busy: queued as a follow-up, or steers the run. */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") => {
      setState((current) => ({ ...current, error: undefined }));
      send({ type: "submit", id: crypto.randomUUID(), text, whenBusy });
    },
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  /** Create a session; resolves with its id once the server answers. */
  const create = useCallback(
    () =>
      new Promise<string>((resolve, reject) => {
        const id = crypto.randomUUID();
        const onMessage = (event: MessageEvent) => {
          let message: ServerMessage;
          try {
            message = JSON.parse(String(event.data)) as ServerMessage;
          } catch {
            return;
          }
          if (!("id" in message) || message.id !== id) return;
          agent.removeEventListener("message", onMessage);
          if (message.type === "error") reject(new Error(message.message));
          else if (message.type === "result") {
            resolve((message.result as { session: string }).session);
          }
        };
        agent.addEventListener("message", onMessage);
        send({ type: "create", id });
      }),
    [agent, send]
  );

  return { ...state, submit, abort, create };
}
