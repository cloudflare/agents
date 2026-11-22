/**
 * Opt-in WebSocket support for Lifecycle Objects: hibernating and Cap'n
 * Web connections plus the Agent identity and `rpc` frame protocol,
 * owned entirely by the capability.
 */
export { WebSockets } from "./websockets";
export {
  EventLog,
  DEFAULT_MAX_EVENT_BYTES,
  type EventLogBatch,
  type EventLogOptions
} from "./event-log";
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
} from "./event-log-protocol";
export {
  CF_EVENT_LOGS_KEY,
  CF_NO_PROTOCOL_KEY,
  CF_READONLY_KEY,
  registerInternalConnectionKeys
} from "./connection-flags";
export type {
  SyncedState,
  WebSocketHandlers,
  WebSocketMessage,
  WebSocketsOptions
} from "./options";
export {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_VALUE,
  capnWebTransportUrl,
  isCapnWebTransportUpgrade,
  type AgentTransport
} from "./transport-protocol";
