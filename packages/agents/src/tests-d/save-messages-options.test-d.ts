/**
 * Type-level tests for `SaveMessagesOptions` and the `"aborted"`
 * extension to `SaveMessagesResult.status` (cloudflare/agents#1406).
 *
 * These verify the public type surface that `@cloudflare/think` and
 * `@cloudflare/ai-chat` re-export from `agents/chat`. A regression in
 * the union or option shape would break callers compiling against the
 * package.
 */

import type { SaveMessagesOptions, SaveMessagesResult } from "../chat/index";

// ── SaveMessagesOptions shape ──────────────────────────────────────

// `signal` is optional and accepts `AbortSignal | undefined`.
const noOptions: SaveMessagesOptions = {};
const withSignal: SaveMessagesOptions = {
  signal: new AbortController().signal
};
const withUndefined: SaveMessagesOptions = { signal: undefined };
void noOptions;
void withSignal;
void withUndefined;

const wrongSignal: SaveMessagesOptions = {
  // @ts-expect-error — non-AbortSignal values are rejected.
  signal: "abort"
};
void wrongSignal;

const extraOption: SaveMessagesOptions = {
  // @ts-expect-error — extra unknown options are rejected (excess
  // property check on object literals). This guards against typos.
  signl: new AbortController().signal
};
void extraOption;

// ── SaveMessagesResult.status union ────────────────────────────────

// All three statuses are valid.
const completed: SaveMessagesResult = {
  requestId: "r-1",
  status: "completed"
};
const skipped: SaveMessagesResult = { requestId: "r-2", status: "skipped" };
const aborted: SaveMessagesResult = { requestId: "r-3", status: "aborted" };
void completed;
void skipped;
void aborted;

const wrongStatus: SaveMessagesResult = {
  requestId: "r-4",
  // @ts-expect-error — values outside the union are rejected.
  status: "running"
};
void wrongStatus;

// Exhaustive switch should narrow with no fall-through gap. Compile-
// time enforcement that callers won't miss a status when the union is
// extended later.
function describe(status: SaveMessagesResult["status"]): string {
  switch (status) {
    case "completed":
      return "ok";
    case "skipped":
      return "skipped";
    case "aborted":
      return "aborted";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
void describe;
