/**
 * Wire protocol shared between server and client.
 *
 * This module is intentionally **runtime-dependency-free** — no
 * imports from `agents`, `@cloudflare/think`, `workers-ai-provider`,
 * or anything else that pulls in Worker-only code. Types here are
 * erased by the bundler; the one runtime constant (`DEMO_USER`) is
 * a plain string. That keeps the front-end bundle from accidentally
 * dragging in the server's Worker runtime via a transitive import.
 *
 * If you add more shared shapes between server and client (e.g. an
 * RPC argument type used by both), add them here, not to `server.ts`.
 */

/**
 * The single Assistant DO name used by this single-user demo. A real
 * app would authenticate the user first and use their id.
 */
export const DEMO_USER = "demo";

// ── Helper protocol ────────────────────────────────────────────────
//
// v0.2 (Option B from `wip/inline-sub-agent-events.md`): the helper
// is itself a Think DO and runs its own inference loop. The parent
// forwards the helper's chat stream chunks (`UIMessageChunk` shapes
// produced by `result.toUIMessageStream()`) verbatim, wrapped in our
// `helper-event` envelope.
//
// Four kinds, two roles:
//
//   - **Lifecycle** (`started`, `finished`, `error`): synthesized by
//     the parent. Always present, always carries enough metadata for
//     the UI to render a panel even before any chunks arrive (and to
//     re-render the panel after refresh from `cf_agent_helper_runs`
//     row data alone).
//
//   - **Stream** (`chunk`): the helper's `UIMessageChunk` body,
//     JSON-stringified once and forwarded as an opaque `body` string.
//     The client parses and applies each body through
//     `applyChunkToParts` from `agents/chat` to rebuild the helper's
//     `UIMessage.parts` shape (text, reasoning, tool calls, results)
//     without reinventing the assembly logic.
//
// The chunk vocabulary is whatever Think's `_streamResult` produces,
// which is the AI SDK `UIMessageChunk` set. Widening to support new
// chunk kinds is a no-op here — the client just learns how to render
// them.

export type HelperEvent =
  | {
      kind: "started";
      helperId: string;
      helperType: string;
      query: string;
    }
  | {
      kind: "chunk";
      helperId: string;
      /**
       * JSON-encoded `UIMessageChunk` body. Forward-as-is on the wire,
       * parse + `applyChunkToParts` on the client. Opaque string so
       * this protocol module stays AI-SDK-version-agnostic.
       */
      body: string;
    }
  | { kind: "finished"; helperId: string; summary: string }
  | { kind: "error"; helperId: string; error: string };

/**
 * Wire frame for a helper event broadcast on the chat WebSocket.
 * The client filters incoming frames by `type === "helper-event"`,
 * then groups by `parentToolCallId` to attach events to the correct
 * tool part in the assistant's message.
 *
 * `sequence` is the per-helper-run 0-based index of this event:
 * lifecycle events are sequence 0 (`started`) and `lastChunk + 1`
 * (`finished` / `error`); chunk events are sequences 1..N matching
 * the helper's own `cf_ai_chat_stream_chunks.chunk_index`. The client
 * uses it to dedupe events that arrive twice across a reconnect
 * (once via `replay`, once via live `broadcast`) when the parent's
 * read loop hadn't yet caught up to what was already durably stored
 * at the moment of refresh.
 *
 * `replay: true` is set on frames sent by the parent's `onConnect`
 * to replay events from helpers that were already in flight when the
 * client connected (or refreshed). The client renders replayed events
 * identically to live ones — a refresh mid-helper looks like a slight
 * pause, then the timeline catches up.
 */
export type HelperEventMessage = {
  type: "helper-event";
  parentToolCallId: string;
  event: HelperEvent;
  sequence: number;
  replay?: true;
};
