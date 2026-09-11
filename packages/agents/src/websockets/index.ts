/**
 * Opt-in WebSocket support for Lifecycle Objects: hibernating and Cap'n
 * Web connections, the Agent identity and `rpc` frame protocol, and
 * Cap'n Web callables, owned entirely by the capability.
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
  capnWebTransportUrl,
  isCapnWebTransportUpgrade,
  type AgentTransport
} from "./transport-protocol";
