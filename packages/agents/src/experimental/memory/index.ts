/**
 * @experimental Memory primitives — unstable API, may change without notice.
 *
 * This module provides session management, event storage, working context,
 * and model format adapters for building context-aware agents.
 *
 * All public classes and functions carry `@experimental` JSDoc tags.
 * Import from `agents/experimental/memory`.
 *
 * **Key exports:**
 * - `SessionAgent` — Agent subclass with session/event SQL methods
 * - `buildWorkingContext` — Pure function to build context from events
 * - `WorkingContext` — Ephemeral in-memory context for LLM invocations
 * - `workersAIAdapter` — Model format adapter for Workers AI
 * - Utility functions: `hydrateEvent`, `dehydrateEvent`, `eventToMessage`, `messageToEvent`
 *
 * **Known limitations:**
 * - Only Workers AI adapter shipped; OpenAI/Anthropic adapters planned
 * - No built-in compaction/summarization yet
 * - Token estimation is not included; bring your own estimator
 * - Concurrent requests: add user messages in-memory via `ctx.addMessage`, persist atomically with the full turn — do NOT `appendEvents` before the LLM call
 * - API will change as we iterate on schemas and primitives
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
  type ModelFormatAdapter
} from "./types";

// Pure utility functions
export {
  hydrateEvent,
  dehydrateEvent,
  eventToMessage,
  messageToEvent
} from "./utils";

// WorkingContext
export { WorkingContext, buildWorkingContext } from "./context";

// SessionAgent
export { SessionAgent } from "./session-agent";

// Adapters
export { workersAIAdapter } from "./adapters/workers-ai";
export type {
  WorkersAIChatMessage,
  WorkersAIChatInput
} from "./adapters/workers-ai";
