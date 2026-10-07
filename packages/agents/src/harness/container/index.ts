/**
 * An agent CLI in a Cloudflare Container, driven from a Durable Object.
 * `ContainerHarness` is a Lifecycle capability with the same interface as
 * `PiHarness`. Pick what runs with a preset (`claudeCode()`, `codex()`):
 * the harness sets the container up from `cloudflare/debian-trixie`, and
 * `ContainerEgress` keeps the credentials outside it.
 *
 * @experimental The API may change before it stabilizes.
 */
export {
  ContainerHarness,
  ContainerSession,
  ContainerSessions,
  ROOT_SESSION,
  type ContainerHarnessOptions,
  type ContainerInstance,
  type ContainerSessionDefaults
} from "./harness";
export {
  claudeCode,
  codex,
  containerAgent,
  echoAgent,
  type ClaudeCodeAgentOptions,
  type CodexAgentOptions,
  type ContainerAgent,
  type ContainerImage,
  type CustomAgentOptions,
  type ProviderConnection
} from "./agents";
export {
  ContainerEgress,
  type ContainerEgressBinding,
  type ContainerEgressProps,
  type EgressRoute
} from "./egress";
export type { SetupStep } from "./managed-image";
export type {
  ContainerEvent,
  ContainerInput,
  ContainerInputPart,
  ContainerMessage,
  ContainerPart,
  ContainerSettings,
  ContainerWhenBusy,
  JsonValue
} from "./protocol";
export type {
  ContainerEventStream,
  ContainerOperationResult,
  ContainerPendingOperation,
  ContainerPromptResponse,
  ContainerReceipt,
  ContainerSessionEvent,
  ContainerSessionId,
  ContainerSessionInfo,
  ContainerSessionOptions,
  ContainerSessionSnapshot,
  ContainerStatus,
  ContainerSubmitOptions
} from "./types";
