/**
 * Type-level tests for `OrphanPersistStore` — the orphan-persist write seam
 * that `@cloudflare/ai-chat` and `@cloudflare/think` route their recovery
 * persist through (`agents/chat`).
 *
 * The load-bearing claim is the prose one: `OrphanPersistStore` is the *write
 * subset* of `SessionProvider`. These assertions pin that so a drift in either
 * interface breaks the build rather than just a comment.
 */

import type { UIMessage } from "ai";
import type { OrphanPersistStore } from "../chat/index";
import type {
  SessionMessage,
  SessionProvider
} from "../experimental/memory/session";

// ── Subset claim ───────────────────────────────────────────────────

// A `SessionProvider` is a structural superset of the orphan-persist write
// subset, so it satisfies `OrphanPersistStore<SessionMessage>`. This is the
// enforced version of "this IS the SessionProvider write-subset".
declare const provider: SessionProvider;
const asStore: OrphanPersistStore<SessionMessage> = provider;
void asStore;

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
