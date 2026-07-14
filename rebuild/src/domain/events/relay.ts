import type { ConversationEventLog } from "./log.js";

/**
 * Structural callback shape shared by `Think.chat()`'s child-relay parameter
 * (app/think.ts's `StreamCallback`) and the delegation module's
 * `ChildChatRelay` (domain/delegation/runs.ts). Both are structurally
 * identical to this; TypeScript's structural typing means none of the three
 * needs to import from either of the others.
 */
export interface RelayCallback {
  onStart(info: { requestId: string }): void;
  onEvent(json: unknown): void;
  onDone(): void;
  onError(err: unknown): void;
  onInterrupted?(): void;
}

/**
 * relayTurn (audit 25 §5, relocated — see adapters/relay/child-relay.ts for
 * why): subscribes to `log` and maps the `ConversationEvent`s of exactly one
 * turn (`requestId`) onto `callback`:
 *   turn:started        -> onStart({ requestId })
 *   chunk                -> onEvent(chunk)
 *   recovering:changed   -> onInterrupted() (only while active)
 *   turn:settled         -> onDone() (completed/suspended) or onError() (failed/cancelled)
 * Unsubscribes itself the moment the turn settles. Also returns the
 * unsubscribe function as a safety net for callers whose turn never reaches
 * `turn:settled` (e.g. admission is rejected before any event publishes).
 *
 * `fromOffset` defaults to `"live"`: correct whenever the subscription is
 * installed *before* the turn starts publishing (Think.chat()'s own use —
 * see app/think.ts). A caller attaching to a turn already in flight (an
 * adapter reattaching after a restart) should pass the turn's
 * `startOffset` instead so it catches up on chunks it missed.
 */
export function relayTurn(
  log: ConversationEventLog,
  requestId: string,
  callback: RelayCallback,
  fromOffset: number | "live" = "live",
): () => void {
  const unsubscribe = log.subscribe(fromOffset, (stored) => {
    const e = stored.event;
    if (e.type === "turn:started" && e.requestId === requestId) {
      callback.onStart({ requestId });
    } else if (e.type === "chunk" && e.requestId === requestId) {
      callback.onEvent(e.chunk);
    } else if (e.type === "recovering:changed" && e.requestId === requestId && e.active) {
      callback.onInterrupted?.();
    } else if (e.type === "turn:settled" && e.requestId === requestId) {
      if (e.outcome === "failed" || e.outcome === "cancelled") {
        callback.onError(e.errorText ?? e.outcome);
      } else {
        callback.onDone();
      }
      unsubscribe();
    }
  });
  return unsubscribe;
}
