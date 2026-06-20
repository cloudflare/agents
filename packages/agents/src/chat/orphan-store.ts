/**
 * OrphanPersistStore — the minimal message store the orphan-persist write
 * (steps (c)/(d) of the chat-recovery orphan path) goes through.
 *
 * It is the **write subset** of the `SessionProvider` interface
 * (`experimental/memory/session`): `getMessage` + `appendMessage` +
 * `updateMessage`. Target-id resolution (step (b)) stays a per-host hook, so
 * `getLatestLeaf` is intentionally omitted here.
 *
 * Parameterized over the host's message type `M` so the seam itself is **not**
 * AI-SDK-specific — mirroring how `SessionProvider` is typed over its own
 * minimal `SessionMessage` rather than the AI SDK's `UIMessage`. The two
 * AI-SDK chat hosts (`@cloudflare/ai-chat`, `@cloudflare/think`) instantiate it
 * at the `UIMessage` default (their orphan reconstruction via
 * `StreamAccumulator.toMessage()` already yields `UIMessage`); `SessionProvider`
 * satisfies it at `SessionMessage`. The AI-SDK-specific *merge* primitive
 * (`reconcileOrphanPartial`) stays typed on `UIMessage` — the store (where
 * messages live) is neutral, the merge (how AI-SDK partials combine) is not.
 *
 * Method returns are `T | Promise<T>` so a synchronous DO-SQLite store and an
 * async (e.g. Postgres) store both satisfy it.
 */

import type { UIMessage } from "ai";

export interface OrphanPersistStore<M extends { id: string } = UIMessage> {
  /** Read the stored message with this id, or `null` if none exists. */
  getMessage(id: string): M | null | Promise<M | null>;

  /**
   * Append a new message. `parentId` is honored by tree-structured stores
   * (`undefined` → attach to the latest leaf); flat-array stores ignore it.
   */
  appendMessage(message: M, parentId?: string | null): void | Promise<void>;

  /** Replace the stored message that owns `message.id`. */
  updateMessage(message: M): void | Promise<void>;
}
