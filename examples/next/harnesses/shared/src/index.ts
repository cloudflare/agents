/**
 * Shared Harness capability for the next harness examples.
 *
 * `new Harness({ tasks, streams, runtime })` gives every harness the same
 * developer API: `harness.session().prompt()`, `interrupt()`, `requests()`,
 * `reply()`, `messages()`, `status()`, `result()`, `wait()`, `events()`.
 * Implementations differ by `HarnessRuntime`, never by subclass.
 */
export {
  Harness,
  harnessOperationStreamId,
  harnessSessionStreamId,
  harnessSessionTag,
  validateSessionId,
  type HarnessOptions
} from "./harness";
export * from "./types";
export * from "./runtime";
export type { SessionMessage, SessionMessagePart } from "agents/sessions";
export type {
  HarnessCallMethod,
  HarnessClientMessage,
  HarnessServerMessage,
  HarnessSnapshot
} from "./protocol";
export { HARNESS_SESSION_QUERY } from "./protocol";
