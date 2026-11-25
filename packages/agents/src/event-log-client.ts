import {
  EVENT_LOG_ERROR,
  EVENT_LOG_EVENTS,
  EVENT_LOG_RESYNC,
  EVENT_LOG_SUBSCRIBE,
  EVENT_LOG_SYNCED,
  EVENT_LOG_UNSUBSCRIBE,
  parseEventLogServerFrame,
  type EventLogCursor
} from "./websockets/event-log-protocol";

/**
 * The socket a log is followed on: an `AgentClient`, or anything with the
 * same `send`, `readyState` and events (a plain browser `WebSocket` works,
 * but does not reconnect).
 *
 * @internal
 */
export type EventLogSocket = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
> & {
  readonly readyState: number;
  send(data: string): unknown;
};

/**
 * Callbacks for one followed log.
 *
 * @internal
 */
export type EventLogHandlers<T = unknown, S = unknown> = {
  /** One event, in seq order. Called for replayed and live events alike. */
  onEvent(data: T, seq: number): void;
  /**
   * Drop what was built from earlier events and start again from
   * `snapshot` (undefined when the log has no snapshot: fetch your own).
   * Called on the first subscription, and whenever the events since the
   * cursor can no longer be replayed.
   */
  onResync(snapshot: S | undefined, seq: number): void;
  /** Replay after a reconnect finished; events from here on are live. */
  onSynced?(seq: number): void;
  /** The server refused the subscription. */
  onError?(error: string): void;
};

/**
 * A followed log.
 *
 * @internal
 */
export type EventLogSubscription = {
  /** The last event applied, or null before the first resync. */
  readonly cursor: EventLogCursor | null;
  /** Stop following: unsubscribe and remove the listeners. */
  close(): void;
};

const OPEN = 1;

/**
 * `reportError` where the runtime has it (browsers, workerd), so error
 * listeners see the throw; elsewhere (Node) a log, never a throw that
 * would end the process.
 */
function reportHandlerError(error: unknown): void {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
  } else {
    console.error("[followEventLog] onEvent threw:", error);
  }
}

/**
 * Open subscriptions per socket and log. Several followers of one log on
 * one socket share the server's subscription, so only the last to close
 * sends the unsubscribe.
 */
const openFollowers = new WeakMap<EventLogSocket, Map<string, number>>();

let followerCount = 0;

function countFollowers(socket: EventLogSocket, log: string, by: number) {
  let logs = openFollowers.get(socket);
  if (!logs) {
    logs = new Map();
    openFollowers.set(socket, logs);
  }
  const count = (logs.get(log) ?? 0) + by;
  if (count > 0) logs.set(log, count);
  else logs.delete(log);
  return count;
}

/**
 * Follow a server event log (`WebSockets.log()`) over a socket. The cursor
 * lives in memory: on every (re)connect the subscription asks for the
 * events after it, so a dropped connection loses nothing the server still
 * holds. When the server cannot replay — the first subscription, history
 * trimmed, events lost in a crash — `onResync` delivers a snapshot to
 * rebuild from. Events can repeat across a reconnect; ones at or before
 * the cursor are dropped here.
 *
 * ```ts
 * const feed = followEventLog(agent, "feed", {
 *   onResync: (snapshot) => { items = snapshot ?? []; },
 *   onEvent: (item) => { items.push(item); }
 * });
 * ```
 *
 * @internal
 */
export function followEventLog<T = unknown, S = unknown>(
  socket: EventLogSocket,
  log: string,
  handlers: EventLogHandlers<T, S>
): EventLogSubscription {
  /** Echoed on the frames that answer this follower's subscribes. */
  const id = `${++followerCount}.${Math.random().toString(36).slice(2, 10)}`;
  let cursor: EventLogCursor | null = null;
  /** Between a subscribe and its `synced`/`resync`: seqs may jump gaps. */
  let replaying = false;
  let closed = false;

  const subscribe = () => {
    replaying = true;
    socket.send(
      JSON.stringify({
        type: EVENT_LOG_SUBSCRIBE,
        log,
        id,
        ...(cursor && { cursor })
      })
    );
  };

  const onMessage = (event: Event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string" || !data.includes("cf_agent_log_")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const frame = parseEventLogServerFrame(parsed);
    if (!frame || frame.log !== log) return;
    // An answer to another follower's subscribe on this socket.
    if (frame.id !== undefined && frame.id !== id) return;
    // A crash resync for every follower, while this follower's own
    // subscribe is unanswered: that answer is computed later, so it wins.
    if (replaying && frame.type === EVENT_LOG_RESYNC && frame.id !== id) return;
    switch (frame.type) {
      case EVENT_LOG_EVENTS: {
        // Before the first resync there is nothing to apply events to.
        if (!cursor) return;
        // While a subscribe is unanswered, only its own replay counts. A
        // live frame here left the server before it read the subscribe, so
        // the replay sends it again in order; applying it now could move
        // the cursor past seqs the replay would then drop.
        if (replaying && frame.id !== id) return;
        for (const entry of frame.events) {
          if (entry.seq <= cursor.seq) continue;
          if (!replaying && entry.seq !== cursor.seq + 1) {
            // A live event skipped seqs: let the server decide between
            // replay and resync.
            subscribe();
            return;
          }
          cursor = { epoch: cursor.epoch, seq: entry.seq };
          // A throwing handler must not cost the rest of the frame: during
          // a replay nothing checks for gaps, so a skipped event would
          // never come again.
          try {
            handlers.onEvent(entry.data as T, entry.seq);
          } catch (error) {
            // Report it as an uncaught error would be (browser error
            // listeners see it), without stopping this frame.
            reportHandlerError(error);
          }
        }
        return;
      }
      case EVENT_LOG_SYNCED:
        replaying = false;
        cursor = {
          epoch: frame.epoch,
          seq: Math.max(cursor?.seq ?? 0, frame.seq)
        };
        handlers.onSynced?.(cursor.seq);
        return;
      case EVENT_LOG_RESYNC:
        replaying = false;
        cursor = { epoch: frame.epoch, seq: frame.seq };
        handlers.onResync(frame.snapshot as S | undefined, frame.seq);
        return;
      case EVENT_LOG_ERROR:
        replaying = false;
        handlers.onError?.(frame.error);
        return;
    }
  };

  countFollowers(socket, log, 1);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("open", subscribe);
  if (socket.readyState === OPEN) subscribe();

  return {
    get cursor() {
      return cursor;
    },
    close() {
      if (closed) return;
      closed = true;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("open", subscribe);
      if (countFollowers(socket, log, -1) === 0 && socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: EVENT_LOG_UNSUBSCRIBE, log }));
      }
    }
  };
}
