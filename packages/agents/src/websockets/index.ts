/**
 * Opt-in WebSocket support for Lifecycle Objects: connection handlers
 * and Cap'n Web callables, owned entirely by the capability.
 *
 * @experimental The WebSockets surface may change before stabilizing.
 */
export { WebSockets } from "./websockets";
export { callablesFromDecorated } from "./callables-target";
export type {
  WebSocketHandlers,
  WebSocketMessage,
  WebSocketsOptions
} from "./options";
export type {
  BridgedConnectionEntry,
  BridgedConnectionLink,
  BridgedConnectionMeta,
  WebSocketsRouteMessage
} from "./bridged";
export {
  CALLABLES_RPC_QUERY,
  CALLABLES_RPC_VALUE,
  callablesRpcUrl,
  isCallablesRpcUpgrade
} from "./protocol";
