/**
 * OpenCode v2 hosted in a Durable Object. `OpenCodeHarness` is a Lifecycle
 * capability that opens OpenCode over the object's SQLite database and wakes
 * it after eviction; OpenCode owns the transcript, the inbox, and every run.
 * It has the same interface as `agents/harness/pi`.
 *
 * @beta The API may change between releases.
 */
export {
  OpenCodeHarness,
  OpenCodeSession,
  OpenCodeSessions,
  ROOT_SESSION,
  type OpenCodeHarnessContext,
  type OpenCodeHarnessFactory,
  type OpenCodeHarnessOptions,
  type OpenCodeModel,
  type OpenCodeSessionDefaults
} from "./harness";
export type {
  OpenCode,
  OpenCodeEvent,
  OpenCodeInput,
  OpenCodeLogEvent,
  OpenCodeMessage,
  OpenCodeOperationResult,
  OpenCodePendingOperation,
  OpenCodePromptResponse,
  OpenCodeReceipt,
  OpenCodeSessionId,
  OpenCodeSessionInfo,
  OpenCodeSessionOptions,
  OpenCodeSubmitOptions,
  OpenCodeWhenBusy
} from "./types";
