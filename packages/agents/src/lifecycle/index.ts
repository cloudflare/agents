/**
 * Durable Object lifecycle composition.
 *
 * @experimental Every export here may change before stabilizing.
 */
export {
  LifecycleCapability,
  type LifecycleAlarms,
  type LifecycleEvents,
  type LifecycleRouteAddress,
  type LifecycleRouteContext,
  type LifecycleHostContextScope,
  type LifecycleRoutes,
  type LifecycleServices,
  type LifecycleSockets
} from "./capability";
export {
  getCurrentAgent,
  type CurrentAgentContext,
  type LifecycleObject
} from "./current-agent";
export {
  Lifecycle,
  type AlarmContribution,
  type Connection,
  type ConnectionContext,
  type ConnectionSetStateFn,
  type ConnectionState,
  type DurableObjectCapability,
  type CapabilityRequestContext,
  type CapabilityStartContext,
  type CapabilityWebSocketUpgradeContext,
  type LifecycleEvent,
  type WSMessage
} from "./durable-object-lifecycle";
