/**
 * Opt-in WebSocket support for Lifecycle Objects: connection handlers,
 * Cap'n Web callables, and a Cap'n Web connection transport, owned
 * entirely by the capability.
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
export {
  CALLABLES_RPC_QUERY,
  CALLABLES_RPC_VALUE,
  callablesRpcUrl,
  isCallablesRpcUpgrade
} from "./protocol";
export {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_VALUE,
  isCapnWebTransportUpgrade
} from "./transport-protocol";
