/**
 * Opt-in WebSocket support for Lifecycle Objects: hibernating and Cap'n
 * Web connections plus the Agent identity and `rpc` frame protocol,
 * owned entirely by the capability.
 *
 * @experimental The WebSockets surface may change before stabilizing.
 */
export { WebSockets } from "./websockets";
export {
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
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type HeartbeatOptions
} from "./heartbeat";
export {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_VALUE,
  capnWebTransportUrl,
  isCapnWebTransportUpgrade,
  type AgentTransport
} from "./transport-protocol";
