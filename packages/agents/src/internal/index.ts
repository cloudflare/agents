/**
 * Sibling-package support for `@cloudflare/think` and `@cloudflare/ai-chat`.
 * Not a public API.
 *
 * Everything here is internal: the capabilities and helpers the slim-hosts
 * work added under the chat hosts (`design/rfc-slim-hosts.md`). Nothing new
 * is exposed to apps until it has shipped inside `Think` and `AIChatAgent`
 * for a release and is shown correct. Names and shapes change without
 * notice. `scripts/public-api.ts` keeps them out of the public entry points.
 *
 * @internal
 * @packageDocumentation
 */

export { TaskSettlement } from "../tasks/settlement";
export type {
  TaskFrameworkDefinition,
  TaskRecord,
  TaskRegisterOptions
} from "../tasks/types";
export * from "../approvals";
export {
  KeepAlive,
  DEFAULT_KEEP_ALIVE_INTERVAL_MS,
  type KeepAliveOptions
} from "../lifecycle/keep-alive";
export {
  declareSchedules,
  listDeclaredSchedules
} from "../schedules/scheduler";
export type {
  DeclaredSchedule,
  DeclaredScheduleContext,
  DeclaredScheduleInfo,
  DeclaredSchedules,
  DeclaredSchedulesSource,
  DeclareSchedulesOptions
} from "../schedules/declared";
export type {
  DeclaredScheduleExpression,
  IntervalScheduleExpression,
  ScheduleTime,
  WallClockScheduleExpression
} from "../schedules/declared-timing";
export { declareEventLog } from "../websockets/websockets";
export {
  EventLog,
  DEFAULT_MAX_EVENT_BYTES,
  type EventLogBatch,
  type EventLogOptions
} from "../websockets/event-log";
export {
  EVENT_LOG_ERROR,
  EVENT_LOG_EVENTS,
  EVENT_LOG_RESYNC,
  EVENT_LOG_SUBSCRIBE,
  EVENT_LOG_SYNCED,
  EVENT_LOG_UNSUBSCRIBE,
  type EventLogCursor,
  type EventLogEntry,
  type EventLogErrorFrame,
  type EventLogEventsFrame,
  type EventLogResyncFrame,
  type EventLogSubscribeFrame,
  type EventLogSyncedFrame,
  type EventLogUnsubscribeFrame
} from "../websockets/event-log-protocol";
export { CF_EVENT_LOGS_KEY } from "../websockets/connection-flags";
export {
  followEventLog,
  type EventLogHandlers,
  type EventLogSocket,
  type EventLogSubscription
} from "../event-log-client";
