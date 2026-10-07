import type {
  OpenCodeMessage,
  OpenCodePendingOperation,
  OpenCodeSessionInfo
} from "agents/harness/opencode";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import type { ClientMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * Text streamed into an assistant message, by OpenCode's ordinal. Text and
 * reasoning parts are numbered separately. OpenCode saves a part to the
 * transcript when it starts, empty, and fills it in when it ends, so until
 * the message completes the live text for an ordinal can be ahead of the
 * saved one.
 */
export type LiveText = {
  readonly text: Readonly<Record<number, string>>;
  readonly reasoning: Readonly<Record<number, string>>;
};

const NO_LIVE_TEXT: LiveText = { text: {}, reasoning: {} };

type Kind = "text" | "reasoning";

/** The saved text of each part of a kind, in ordinal order. */
function savedTexts(
  message: OpenCodeMessage | undefined,
  kind: Kind
): string[] {
  if (message?.type !== "assistant") return [];
  return message.content.flatMap((part) =>
    part.type === kind ? [part.text] : []
  );
}

/**
 * The text to show for each part of a kind, in ordinal order: the saved
 * text, or the live text where it has got further, plus live parts the
 * snapshot does not have yet.
 */
export function partTexts(
  live: LiveText | undefined,
  message: OpenCodeMessage | undefined,
  kind: Kind
): string[] {
  const saved = savedTexts(message, kind);
  const streamed = live?.[kind] ?? {};
  const count = Math.max(
    saved.length,
    ...Object.keys(streamed).map((ordinal) => Number(ordinal) + 1)
  );
  return Array.from({ length: count }, (_, ordinal) => {
    const fromSnapshot = saved[ordinal] ?? "";
    const fromLive = streamed[ordinal] ?? "";
    return fromLive.length > fromSnapshot.length ? fromLive : fromSnapshot;
  });
}

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

/** Drop live text a snapshot has caught up with. */
function prune(
  live: State["live"],
  messages: readonly OpenCodeMessage[]
): State["live"] {
  const next: Record<string, LiveText> = {};
  for (const [id, text] of Object.entries(live)) {
    const message = messages.find((candidate) => candidate.id === id);
    if (message?.type === "assistant" && message.time.completed !== undefined) {
      continue;
    }
    const keep = (kind: Kind) => {
      const saved = savedTexts(message, kind);
      return Object.fromEntries(
        Object.entries(text[kind]).filter(
          ([ordinal, value]) =>
            value.length > (saved[Number(ordinal)] ?? "").length
        )
      );
    };
    next[id] = { text: keep("text"), reasoning: keep("reasoning") };
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
          const { assistantMessageID: id, ordinal, delta } = opencode.data;
          const kind =
            opencode.type === "session.text.delta" ? "text" : "reasoning";
          setState((current) => {
            const previous = current.live[id] ?? NO_LIVE_TEXT;
            return {
              ...current,
              busy: true,
              live: {
                ...current.live,
                [id]: {
                  ...previous,
                  [kind]: {
                    ...previous[kind],
                    [ordinal]: (previous[kind][ordinal] ?? "") + delta
                  }
                }
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

  /**
   * Create a session; resolves with its id once the server answers, and
   * rejects if the socket closes first or no answer comes in 30 seconds.
   */
  const create = useCallback(
    () =>
      new Promise<string>((resolve, reject) => {
        const id = crypto.randomUUID();
        const done = () => {
          clearTimeout(timer);
          agent.removeEventListener("message", onMessage);
          agent.removeEventListener("close", onClose);
        };
        const onClose = () => {
          done();
          reject(
            new Error("The connection closed before the session was created")
          );
        };
        const onMessage = (event: MessageEvent) => {
          let message: ServerMessage;
          try {
            message = JSON.parse(String(event.data)) as ServerMessage;
          } catch {
            return;
          }
          if (!("id" in message) || message.id !== id) return;
          done();
          if (message.type === "error") reject(new Error(message.message));
          else if (message.type === "result") {
            resolve((message.result as { session: string }).session);
          }
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error("Creating the session timed out"));
        }, 30_000);
        agent.addEventListener("message", onMessage);
        agent.addEventListener("close", onClose);
        send({ type: "create", id });
      }),
    [agent, send]
  );

  /** Show an error from an action the server never answered. */
  const fail = useCallback((error: unknown) => {
    setState((current) => ({
      ...current,
      error: error instanceof Error ? error.message : String(error)
    }));
  }, []);

  return { ...state, submit, abort, create, fail };
}
