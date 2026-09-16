/**
 * Type-level tests for `OrphanPersistStore` — the orphan-persist write seam
 * that `@cloudflare/ai-chat` and `@cloudflare/think` route their recovery
 * persist through (`agents/chat`).
 *
 * The seam deliberately contains only the three operations recovery needs.
 * These assertions pin its synchronous and asynchronous implementations.
 */

import type { UIMessage } from "ai";
import type { OrphanPersistStore } from "../chat/index";
import type { SessionMessage } from "../sessions";

// ── Default instantiation (AI-SDK hosts) ───────────────────────────

// The two AI-SDK chat hosts use the `UIMessage` default; `UIMessage` satisfies
// the `{ id: string }` bound, so the bare form and the explicit form agree.
declare const uiStore: OrphanPersistStore;
const explicitUi: OrphanPersistStore<UIMessage> = uiStore;
void explicitUi;

// ── Shape guards ────────────────────────────────────────────────────

// A store missing a write method is rejected — the contract is all three.
const incomplete: OrphanPersistStore<SessionMessage> = {
  getMessage: () => null,
  appendMessage: () => {},
  // @ts-expect-error — `updateMessage` is required.
  updateMessage: undefined
};
void incomplete;

// Sync-or-async returns are both allowed (a DO-SQLite store is synchronous;
// a Postgres-backed one is async).
const syncStore: OrphanPersistStore<SessionMessage> = {
  getMessage: () => null,
  appendMessage: () => {},
  updateMessage: () => {}
};
const asyncStore: OrphanPersistStore<SessionMessage> = {
  getMessage: async () => null,
  appendMessage: async () => {},
  updateMessage: async () => {}
};
void syncStore;
void asyncStore;
