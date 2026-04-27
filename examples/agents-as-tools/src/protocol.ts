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
// Two layers:
//
//   - `HelperEvent` — what a helper emits. Six kinds; deliberately
//     small. Each event carries a `helperId` so multiple helpers in
//     the same turn (when v0.1 ships parallel fan-out) can be demuxed
//     by the client.
//
//   - `HelperEventMessage` — the on-the-wire wrapper. Tags every
//     event with the originating chat `parentToolCallId` so the
//     client renders helper events inline under the matching tool
//     part in the assistant's message.

export type HelperEvent =
  | { kind: "started"; helperId: string; helperType: string; query: string }
  | { kind: "step"; helperId: string; step: number; description: string }
  | {
      kind: "tool-call";
      helperId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: "tool-result";
      helperId: string;
      toolCallId: string;
      output: unknown;
    }
  | { kind: "finished"; helperId: string; summary: string }
  | { kind: "error"; helperId: string; error: string };

/**
 * Wire frame for a helper event broadcast on the chat WebSocket.
 * The client filters incoming frames by `type === "helper-event"`,
 * then groups by `parentToolCallId` to attach events to the correct
 * tool part in the assistant message.
 *
 * `sequence` is the helper-local 0-based index of this event within
 * its run — equivalent to `chunk_index` in the helper's
 * `ResumableStream`. The client uses it to dedupe events that arrive
 * twice across a reconnect (once via `replay`, once via live
 * `broadcast`) when the parent's read loop hadn't yet caught up to
 * what was already durably stored at the moment of refresh.
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
