/**
 * @experimental Memory primitives context — unstable, may change without notice.
 *
 * WorkingContext is the in-memory, ephemeral context used for a single LLM invocation.
 * It is built from loaded session events, accumulates new messages during an agentic loop,
 * and tracks which messages are new (for batch persistence at request end).
 */

import type {
  ContextMessage,
  SessionEvent,
  ContextBuilderOptions,
} from "./types";
import { eventToMessage as defaultEventToMessage } from "./utils";

/**
 * @experimental
 * In-memory ephemeral context for a single request/LLM invocation.
 *
 * - Built at the start of each user request via `buildWorkingContext`.
 * - Messages accumulate during the agentic loop.
 * - Never persisted to SQL directly — call `getNewMessages()` to extract
 *   messages added after initial construction, then persist them.
 * - Thrown away after the request completes.
 */
export class WorkingContext {
  systemInstructions: string[];
  messages: ContextMessage[];
  metadata: Record<string, unknown>;
  private _initialCount: number;

  constructor(
    systemInstructions: string[] = [],
    messages: ContextMessage[] = [],
    metadata: Record<string, unknown> = {}
  ) {
    this.systemInstructions = systemInstructions;
    this.messages = messages;
    this.metadata = metadata;
    this._initialCount = messages.length;
  }

  /**
   * Append a message to the context. Messages added via this method
   * are tracked as "new" and returned by `getNewMessages()`.
   */
  addMessage(msg: ContextMessage): void {
    this.messages.push(msg);
  }

  /**
   * Returns only the messages added after the initial build.
   * These are the messages that need to be persisted to the session store.
   */
  getNewMessages(): ContextMessage[] {
    return this.messages.slice(this._initialCount);
  }
}

/**
 * @experimental
 * Build a WorkingContext from a list of session events.
 *
 * This is a **pure function** — no SQL dependency. Safe to call from
 * Agents, Workflows, Workers, or tests.
 *
 * @param events - Session events (typically loaded via `agent.loadEvents()`)
 * @param options - System instructions, custom event→message mapper, etc.
 * @returns A new WorkingContext with loaded events as the initial message set.
 */
export function buildWorkingContext(
  events: SessionEvent[],
  options: ContextBuilderOptions = {}
): WorkingContext {
  const mapper = options.eventToMessage ?? defaultEventToMessage;
  const messages: ContextMessage[] = [];

  for (const event of events) {
    const msg = mapper(event);
    if (msg !== null) {
      messages.push(msg);
    }
  }

  return new WorkingContext(
    options.systemInstructions ?? [],
    messages,
    {}
  );
}
