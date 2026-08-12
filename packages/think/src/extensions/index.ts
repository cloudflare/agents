export { ExtensionManager, sanitizeName } from "./manager";
export type { ExtensionManagerOptions } from "./manager";
export { createExtensionTools } from "./tools";
export type { ExtensionToolsOptions } from "./tools";
export {
  createTurnContextSnapshot,
  parseHookResult,
  createToolCallStartSnapshot,
  createToolCallFinishSnapshot,
  createStepFinishSnapshot,
  createChunkSnapshot
} from "./hook-proxy";
export { HostBridgeLoopback } from "./host-bridge";
export type { HostBridgeLoopbackProps } from "./host-bridge";
export {
  createBridgeProvider,
  ExtensionContextBridge,
  ExtensionWritableBridge,
  ExtensionSkillBridge
} from "./bridge-provider";
export type {
  ExtensionManifest,
  ExtensionPermissions,
  ExtensionToolDescriptor,
  ExtensionInfo
} from "./types";
