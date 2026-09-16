/**
 * What the browser needs to talk about a pi session: the harness protocol pi
 * declares, and the projected pi types its events carry. No runtime imports,
 * so the client bundle never reaches a server module.
 */
export type {
  PiEvent,
  PiMessage,
  PiMessagePart,
  PiOperationResult,
  PiProtocol,
  PiQueuedItem,
  PiResult,
  PiSubmission,
  PiToolInfo,
  PiToolResult
} from "./harness/types";
