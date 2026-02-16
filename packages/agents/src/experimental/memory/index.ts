/**
 * @experimental Memory primitives — unstable, may change without notice.
 *
 * This module provides session management, event storage, working context,
 * and model format adapters for building context-aware agents.
 *
 * **Key exports:**
 * - `SessionAgent` — Agent subclass with session/event SQL methods
 * - `buildWorkingContext` — Pure function to build WorkingContext from events
 * - `WorkingContext` — Ephemeral in-memory context for LLM invocations
 * - `workersAIAdapter` — Model format adapter for Workers AI
 * - Utility functions: `hydrateEvent`, `dehydrateEvent`, `eventToMessage`, `messageToEvent`
 */

// Types
export {
  EventAction,
  type EventActionType,
  type StoredSession,
  type StoredEvent,
  type SessionEvent,
  type ToolCall,
  type ContextMessage,
  type LoadEventsOptions,
  type ContextBuilderOptions,
  type ModelFormatAdapter,
} from "./types";

// Pure utility functions
export {
  hydrateEvent,
  dehydrateEvent,
  eventToMessage,
  messageToEvent,
} from "./utils";

// WorkingContext
export { WorkingContext, buildWorkingContext } from "./context";

// SessionAgent
export { SessionAgent } from "./session-agent";

// Adapters
export { workersAIAdapter } from "./adapters/workers-ai";
export type {
  WorkersAIChatMessage,
  WorkersAIChatInput,
} from "./adapters/workers-ai";
