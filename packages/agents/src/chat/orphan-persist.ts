/**
 * Orphan-persist core — reconstruct a message from an interrupted stream's
 * buffered chunks and upsert it through an {@link OrphanPersistStore}.
 *
 * This is the genuinely-shared skeleton extracted from the two AI-SDK chat
 * hosts' `_persistOrphanedStream` (`@cloudflare/think` and
 * `@cloudflare/ai-chat`): the accumulate loop plus the
 * `getMessage → updateMessage(merge) XOR appendMessage` upsert. The
 * deliberately host-specific bits stay in the callers:
 *
 *   - buffer flush (Think flushes defensively first; ai-chat doesn't);
 *   - the fallback message id;
 *   - `prepare` — Think strips internal parts and may skip (`null`); ai-chat
 *     resolves the persist-target id from stream metadata;
 *   - `merge` — Think replaces the whole message; ai-chat reconciles partials
 *     so an in-place tool result isn't re-advanced by a replayed chunk; and
 *   - broadcast (Think broadcasts after; ai-chat broadcasts inside its store's
 *     `persistMessages`).
 *
 * Pure orchestration: it performs exactly one store write (update XOR append),
 * never touches the buffer, and never broadcasts.
 *
 * @internal Shared chat-recovery internals; not a public API.
 */

import type { UIMessage } from "ai";
import { StreamAccumulator } from "./stream-accumulator";
import type { StreamChunkData } from "./message-builder";
import type { OrphanPersistStore } from "./orphan-store";

export interface PersistReconstructedOrphanOptions<
  TMessage extends UIMessage = UIMessage
> {
  /** The store seam to upsert through (a `SessionProvider` write-subset). */
  store: OrphanPersistStore<TMessage>;
  /**
   * Id for the reconstructed message when the stream carried no provider
   * `start.messageId` to adopt. The accumulator still adopts a provider id when
   * present.
   */
  fallbackId: string;
  /**
   * Finalize the reconstructed message before upsert — e.g. strip internal
   * parts or resolve the persist-target id. Return `null` to skip persistence
   * entirely (e.g. an empty structural-only message).
   */
  prepare: (message: TMessage) => TMessage | null;
  /**
   * Combine an existing row with the reconstructed message when a row already
   * owns the id (replace, or reconcile partials).
   */
  merge: (existing: TMessage, incoming: TMessage) => TMessage;
}

/**
 * Reconstruct a message from `chunks` and upsert it via the store. Returns
 * `true` when a write happened (so a caller that broadcasts after — Think — can
 * gate its broadcast on it), `false` when there was nothing to persist (no
 * parts, or `prepare` returned `null`).
 */
export async function persistReconstructedOrphan<
  TMessage extends UIMessage = UIMessage
>(
  chunks: ReadonlyArray<{ body: string }>,
  options: PersistReconstructedOrphanOptions<TMessage>
): Promise<boolean> {
  if (chunks.length === 0) return false;

  const accumulator = new StreamAccumulator({ messageId: options.fallbackId });
  for (const chunk of chunks) {
    try {
      accumulator.applyChunk(JSON.parse(chunk.body) as StreamChunkData);
    } catch {
      // Skip malformed chunk bodies.
    }
  }

  if (accumulator.parts.length === 0) return false;

  const prepared = options.prepare(accumulator.toMessage() as TMessage);
  if (prepared === null) return false;

  const existing = await options.store.getMessage(prepared.id);
  if (existing) {
    await options.store.updateMessage(options.merge(existing, prepared));
  } else {
    await options.store.appendMessage(prepared);
  }
  return true;
}
