/**
 * `useHarnessSession`: one React hook for every harness. Connects with
 * `useAgent`, takes a snapshot, subscribes from the snapshot's cursor, and
 * keeps status, open requests, the transcript and live previews in state.
 *
 * Three rules keep reconnects exact: resubscribe from the last cursor,
 * re-snapshot at operation boundaries, and drop previews on reconnect.
 *
 * Browser-only: this module must never import a server module.
 */
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionMessage } from "agents/sessions";
import {
  HARNESS_SESSION_QUERY,
  type HarnessCallMethod,
  type HarnessClientMessage,
  type HarnessServerMessage
} from "./protocol";
import type {
  HarnessCompactOptions,
  HarnessConfig,
  HarnessConfigPatch,
  HarnessEvent,
  HarnessInput,
  HarnessInterruptOptions,
  HarnessInterruptResult,
  HarnessPromptOptions,
  HarnessProtocol,
  HarnessReceipt,
  HarnessReply,
  HarnessRequest,
  HarnessStatus,
  JsonValue
} from "./types";

export type HarnessConnectionStatus = "connecting" | "open" | "closed";

/** A message being streamed token by token. */
export type HarnessLiveMessage = {
  readonly messageId: string;
  readonly text: string;
  readonly reasoning: string;
};

export type HarnessSessionState<P extends HarnessProtocol = HarnessProtocol> = {
  readonly connection: HarnessConnectionStatus;
  readonly status: HarnessStatus | null;
  readonly requests: readonly HarnessRequest[];
  readonly messages: readonly SessionMessage[];
  /** Recent events, oldest first, bounded by `keepEvents`. */
  readonly events: readonly HarnessEvent<P>[];
  /** Live token deltas since the last settled message, or null when idle. */
  readonly live: HarnessLiveMessage | null;
  /** True until the first replay has drained. */
  readonly replaying: boolean;
  /** Ranges of the log that were lost (a truncated remote outbox). */
  readonly gaps: readonly {
    readonly from: number;
    readonly to: number;
    readonly reason: string;
  }[];
  readonly error: string | undefined;
};

export type UseHarnessSessionOptions = {
  /** The Durable Object binding name, as `useAgent` takes it. */
  readonly agent: string;
  /** The object name. */
  readonly name: string;
  /** The harness session on that object. Default `"main"`. */
  readonly sessionId?: string;
  /** Receive token deltas as `live`. Default true. */
  readonly previews?: boolean;
  /** Events kept in state. Default 500. */
  readonly keepEvents?: number;
  /** Optional path segments for a sub-agent, as `useAgent` takes them. */
  readonly sub?: ReadonlyArray<{ agent: string; name: string }>;
};

export type UseHarnessSessionResult<
  P extends HarnessProtocol = HarnessProtocol
> = HarnessSessionState<P> & {
  prompt(
    input: HarnessInput,
    options?: HarnessPromptOptions
  ): Promise<HarnessReceipt>;
  interrupt(options?: HarnessInterruptOptions): Promise<HarnessInterruptResult>;
  reply(
    requestId: string,
    reply: HarnessReply
  ): Promise<{ readonly accepted: boolean }>;
  submit(submission: P["submit"]): Promise<HarnessReceipt>;
  compact(options?: HarnessCompactOptions): Promise<HarnessReceipt>;
  configure(patch: HarnessConfigPatch): Promise<HarnessConfig>;
  /** Any method callable over the browser link. */
  call(method: HarnessCallMethod, ...args: JsonValue[]): Promise<JsonValue>;
  /** Ask the server for a fresh snapshot. */
  refresh(): void;
};

const DEFAULT_KEEP_EVENTS = 500;
const SNAPSHOT_DEBOUNCE_MS = 150;

function initialState<P extends HarnessProtocol>(): HarnessSessionState<P> {
  return {
    connection: "connecting",
    status: null,
    requests: [],
    messages: [],
    events: [],
    live: null,
    replaying: true,
    gaps: [],
    error: undefined
  };
}

type Pending = {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
};

export function useHarnessSession<P extends HarnessProtocol = HarnessProtocol>(
  options: UseHarnessSessionOptions
): UseHarnessSessionResult<P> {
  const sessionId = options.sessionId ?? "main";
  const previews = options.previews ?? true;
  const keepEvents = options.keepEvents ?? DEFAULT_KEEP_EVENTS;
  const [state, setState] = useState<HarnessSessionState<P>>(initialState);
  const cursor = useRef<string | undefined>(undefined);
  const pending = useRef(new Map<string, Pending>());
  const subscribed = useRef(false);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  const agent = useAgent({
    agent: options.agent,
    name: options.name,
    query: { [HARNESS_SESSION_QUERY]: sessionId },
    ...(options.sub === undefined ? {} : { sub: [...options.sub] }),
    onOpen: () => {
      subscribed.current = false;
      setState((current) => ({ ...current, connection: "open", live: null }));
    },
    onClose: () => {
      subscribed.current = false;
      setState((current) => ({ ...current, connection: "closed" }));
      for (const waiter of pending.current.values()) {
        waiter.reject(new Error("Harness socket closed"));
      }
      pending.current.clear();
    },
    onMessage: (event) => {
      let message: HarnessServerMessage<P>;
      try {
        message = JSON.parse(String(event.data)) as HarnessServerMessage<P>;
      } catch {
        return;
      }
      switch (message.type) {
        case "snapshot": {
          setState((current) => ({
            ...current,
            status: message.status,
            requests: message.requests,
            messages: message.messages.messages,
            error: undefined
          }));
          if (!subscribed.current) {
            subscribed.current = true;
            // History and the tail meet exactly once: subscribe from the
            // page's cursor on a fresh connection, else from the last one.
            const from = cursor.current ?? message.messages.asOf;
            agent.send(
              JSON.stringify({
                type: "subscribe",
                from,
                previews
              } satisfies HarnessClientMessage)
            );
          }
          return;
        }
        case "events": {
          const last = message.events.at(-1);
          if (last) cursor.current = last.cursor;
          let boundary = false;
          setState((current) => {
            let next = current;
            for (const item of message.events) next = reduce(next, item);
            const events = [...current.events, ...message.events].slice(
              -keepEvents
            );
            return { ...next, events };
          });
          for (const item of message.events) {
            const type = item.body.type;
            if (
              type === "operation_started" ||
              type === "operation_settled" ||
              type === "request_raised" ||
              type === "request_replied"
            ) {
              boundary = true;
            }
          }
          // The transcript and status are authoritative at boundaries; one
          // snapshot per burst of boundary events.
          if (boundary && snapshotTimer.current === undefined) {
            snapshotTimer.current = setTimeout(() => {
              snapshotTimer.current = undefined;
              if (agent.readyState !== WebSocket.OPEN) return;
              agent.send(
                JSON.stringify({
                  type: "snapshot",
                  id: crypto.randomUUID()
                } satisfies HarnessClientMessage)
              );
            }, SNAPSHOT_DEBOUNCE_MS);
          }
          return;
        }
        case "preview": {
          const body = message.preview.body;
          setState((current) => {
            const live =
              current.live && current.live.messageId === body.messageId
                ? current.live
                : { messageId: body.messageId, text: "", reasoning: "" };
            return {
              ...current,
              live:
                body.type === "text_delta"
                  ? { ...live, text: live.text + body.delta }
                  : { ...live, reasoning: live.reasoning + body.delta }
            };
          });
          return;
        }
        case "up_to_date":
          setState((current) => ({ ...current, replaying: false }));
          return;
        case "result": {
          const waiter = pending.current.get(message.id);
          pending.current.delete(message.id);
          waiter?.resolve(message.value);
          return;
        }
        case "error": {
          if (message.id !== undefined) {
            const waiter = pending.current.get(message.id);
            pending.current.delete(message.id);
            if (waiter) {
              const error = new Error(message.error.message);
              error.name = message.error.name;
              waiter.reject(error);
              return;
            }
          }
          setState((current) => ({
            ...current,
            error: message.error.message
          }));
          return;
        }
        default:
          return;
      }
    }
  });

  const subKey = JSON.stringify(options.sub ?? []);
  useEffect(() => {
    setState(initialState());
    cursor.current = undefined;
    subscribed.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.agent, options.name, sessionId, subKey]);

  const call = useCallback(
    (method: HarnessCallMethod, ...args: JsonValue[]): Promise<JsonValue> =>
      new Promise((resolve, reject) => {
        if (agent.readyState !== WebSocket.OPEN) {
          reject(new Error("Harness socket is not open"));
          return;
        }
        const id = crypto.randomUUID();
        pending.current.set(id, { resolve, reject });
        agent.send(
          JSON.stringify({
            type: "call",
            id,
            method,
            args
          } satisfies HarnessClientMessage)
        );
      }),
    [agent]
  );

  const refresh = useCallback(() => {
    if (agent.readyState !== WebSocket.OPEN) return;
    agent.send(
      JSON.stringify({
        type: "snapshot",
        id: crypto.randomUUID()
      } satisfies HarnessClientMessage)
    );
  }, [agent]);

  // SAFETY: the server answers each method with that method's result shape.
  const callAs = useCallback(
    <T>(method: HarnessCallMethod, ...args: unknown[]): Promise<T> =>
      call(method, ...(args as JsonValue[])) as Promise<unknown> as Promise<T>,
    [call]
  );
  const prompt = useCallback(
    (input: HarnessInput, promptOptions?: HarnessPromptOptions) =>
      callAs<HarnessReceipt>("prompt", input, promptOptions ?? {}),
    [callAs]
  );
  const interrupt = useCallback(
    (interruptOptions?: HarnessInterruptOptions) =>
      callAs<HarnessInterruptResult>("interrupt", interruptOptions ?? {}),
    [callAs]
  );
  const reply = useCallback(
    (requestId: string, answer: HarnessReply) =>
      callAs<{ readonly accepted: boolean }>("reply", requestId, answer),
    [callAs]
  );
  const submit = useCallback(
    (submission: P["submit"]) => callAs<HarnessReceipt>("submit", submission),
    [callAs]
  );
  const compact = useCallback(
    (compactOptions?: HarnessCompactOptions) =>
      callAs<HarnessReceipt>("compact", compactOptions ?? {}),
    [callAs]
  );
  const configure = useCallback(
    (patch: HarnessConfigPatch) => callAs<HarnessConfig>("configure", patch),
    [callAs]
  );

  return {
    ...state,
    prompt,
    interrupt,
    reply,
    submit,
    compact,
    configure,
    call,
    refresh
  };
}

function reduce<P extends HarnessProtocol>(
  state: HarnessSessionState<P>,
  event: HarnessEvent<P>
): HarnessSessionState<P> {
  const body = event.body;
  switch (body.type) {
    case "operation_started":
      return { ...state, error: undefined };
    case "operation_settled":
      return {
        ...state,
        live: null,
        ...(body.result.status === "failed" && body.result.error
          ? { error: body.result.error.message }
          : {})
      };
    case "message_end": {
      // The settled parts land in the transcript at once; the next
      // snapshot re-reads them from the runtime.
      const settled = {
        id: body.messageId,
        role: body.role,
        parts: [...body.parts]
      };
      const known = state.messages.findIndex(
        (message) => message.id === body.messageId
      );
      const messages =
        known >= 0
          ? state.messages.map((message, index) =>
              index === known ? settled : message
            )
          : [...state.messages, settled];
      return {
        ...state,
        messages,
        live: state.live?.messageId === body.messageId ? null : state.live
      };
    }
    case "gap":
      return {
        ...state,
        gaps: [
          ...state.gaps,
          { from: body.from, to: body.to, reason: body.reason }
        ]
      };
    case "request_raised":
      return state.requests.some(
        (request) => request.requestId === body.request.requestId
      )
        ? state
        : { ...state, requests: [...state.requests, body.request] };
    case "request_replied":
      return {
        ...state,
        requests: state.requests.filter(
          (request) => request.requestId !== body.requestId
        )
      };
    case "status":
      return { ...state, status: body.status };
    case "error":
      return { ...state, error: body.error.message };
    default:
      return state;
  }
}
