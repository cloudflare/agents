/**
 * Wire frames of an event log: what a client sends to follow a log and
 * what the server answers. Browser-safe — imported by the client too.
 */

/** Where a client is in a log: the log's epoch and the last seq it applied. */
export type EventLogCursor = {
  readonly epoch: string;
  readonly seq: number;
};

/** One sequenced event as it travels on the wire. */
export type EventLogEntry<T = unknown> = {
  readonly seq: number;
  readonly data: T;
};

export const EVENT_LOG_SUBSCRIBE = "cf_agent_log_subscribe";
export const EVENT_LOG_UNSUBSCRIBE = "cf_agent_log_unsubscribe";
export const EVENT_LOG_EVENTS = "cf_agent_log_events";
export const EVENT_LOG_SYNCED = "cf_agent_log_synced";
export const EVENT_LOG_RESYNC = "cf_agent_log_resync";
export const EVENT_LOG_ERROR = "cf_agent_log_error";

/** Client to server: follow a log, from a cursor when the client has one. */
export type EventLogSubscribeFrame = {
  readonly type: typeof EVENT_LOG_SUBSCRIBE;
  readonly log: string;
  readonly cursor?: EventLogCursor;
};

/** Client to server: stop following a log. */
export type EventLogUnsubscribeFrame = {
  readonly type: typeof EVENT_LOG_UNSUBSCRIBE;
  readonly log: string;
};

/** Server to client: events in seq order, replayed or live. */
export type EventLogEventsFrame<T = unknown> = {
  readonly type: typeof EVENT_LOG_EVENTS;
  readonly log: string;
  readonly events: readonly EventLogEntry<T>[];
};

/** Server to client: replay is done; events from here on are live. */
export type EventLogSyncedFrame = {
  readonly type: typeof EVENT_LOG_SYNCED;
  readonly log: string;
  readonly epoch: string;
  readonly seq: number;
};

/**
 * Server to client: the cursor cannot be replayed. Drop local state and
 * rebuild from `snapshot` (absent when the log has no snapshot); the cursor
 * becomes `{ epoch, seq }`, and events from here on are live.
 */
export type EventLogResyncFrame<S = unknown> = {
  readonly type: typeof EVENT_LOG_RESYNC;
  readonly log: string;
  readonly epoch: string;
  readonly seq: number;
  readonly snapshot?: S;
};

/** Server to client: the subscription was refused. */
export type EventLogErrorFrame = {
  readonly type: typeof EVENT_LOG_ERROR;
  readonly log: string;
  readonly error: string;
};

export type EventLogClientFrame =
  | EventLogSubscribeFrame
  | EventLogUnsubscribeFrame;

export type EventLogServerFrame =
  | EventLogEventsFrame
  | EventLogSyncedFrame
  | EventLogResyncFrame
  | EventLogErrorFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCursor(value: unknown): value is EventLogCursor {
  return (
    isRecord(value) &&
    typeof value.epoch === "string" &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq)
  );
}

/** Narrow a parsed client frame to an event log frame, or undefined. */
export function parseEventLogClientFrame(
  value: unknown
): EventLogClientFrame | undefined {
  if (!isRecord(value) || typeof value.log !== "string") return undefined;
  if (value.type === EVENT_LOG_UNSUBSCRIBE) {
    return { type: EVENT_LOG_UNSUBSCRIBE, log: value.log };
  }
  if (value.type !== EVENT_LOG_SUBSCRIBE) return undefined;
  return {
    type: EVENT_LOG_SUBSCRIBE,
    log: value.log,
    // A malformed cursor is treated as none: the client gets a resync.
    ...(isCursor(value.cursor) && { cursor: value.cursor })
  };
}

/** Narrow a parsed server frame to an event log frame, or undefined. */
export function parseEventLogServerFrame(
  value: unknown
): EventLogServerFrame | undefined {
  if (!isRecord(value) || typeof value.log !== "string") return undefined;
  switch (value.type) {
    case EVENT_LOG_EVENTS:
      return Array.isArray(value.events)
        ? (value as EventLogEventsFrame)
        : undefined;
    case EVENT_LOG_SYNCED:
    case EVENT_LOG_RESYNC:
      return typeof value.epoch === "string" && typeof value.seq === "number"
        ? (value as EventLogSyncedFrame | EventLogResyncFrame)
        : undefined;
    case EVENT_LOG_ERROR:
      return typeof value.error === "string"
        ? (value as EventLogErrorFrame)
        : undefined;
    default:
      return undefined;
  }
}
