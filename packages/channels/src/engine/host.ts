import type { TurnStore } from "../storage/store";

/**
 * The Host port — everything the engine uses from the platform, so the
 * engine is testable without a Durable Object and portable if the substrate
 * changes. Three capabilities, nothing more: transactional storage, "don't
 * evict me mid-turn," and "wake me later." Restart detection is implicit —
 * the recovery scan runs on the first event after construction.
 */
export interface TurnEngineHost {
  /** Typed transactional storage; today backed by the DO's SQLite. */
  storage: TurnStore;
  /** Keep the host alive while asynchronous turn work is pending. */
  holdWhile<T>(work: Promise<T>): Promise<T>;
  /**
   * Durable timer: wake the engine host at (or before) `at` ms since epoch.
   * Set-if-earlier semantics — a wake may fire early and must be treated
   * as possibly spurious.
   */
  wake(at: number): void;
  now(): number;
}
