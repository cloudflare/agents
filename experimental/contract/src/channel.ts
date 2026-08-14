/**
 * channel — bidirectional adapters between the log and external surfaces. The
 * WS chat protocol, Telegram, email, cron ticks, workflow callbacks, and a
 * parent agent's RPC are all channels. "Everything that gets work in is a
 * channel."
 *
 * Inbound: channel code translates an external event into entries and submits
 * them through the Inbox — append-with-idempotency IS the durable inbox
 * (Think's submitMessages collapses into it).
 *
 * Outbound: the engine drives delivery through a durable consumer, so the
 * channel never manages cursors, retries or outboxes. Its residue is the last
 * mile only (residue 1): declare whether repetition is safe and honor that in
 * deliver(). deliver() runs according to the shared RetryContract; the attempt
 * number in DeliveryDeps is the standing at-least-once reminder.
 *
 * Realtime media (voice) does NOT ride the log. RealtimeSession's redesign is
 * deferred; only semantic results are committed.
 *
 * Allowed imports: kernel, transcript, tools.
 */

import type { ConsumerName } from "./kernel.js";
import type { AppendResult, Entry, NewEntry, Query } from "./transcript.js";
import type { RetryContract } from "./tools.js";

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface Inbox {
  submit(
    entries: readonly NewEntry[],
    opts?: { idempotencyKey?: string }
  ): Promise<AppendResult>;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export interface DeliveryDeps {
  /** Stable per (entry batch, consumer); same on every redelivery. */
  readonly dedupeKey: string;
  /** 1-based redelivery counter. >1 means a previous attempt may have landed. */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface Outbox {
  readonly consumer: ConsumerName;
  readonly filter: Pick<Query, "kinds" | "correlation" | "turn">;
  readonly contract: RetryContract;
  deliver(entries: readonly Entry[], deps: DeliveryDeps): Promise<void>;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export interface Channel {
  readonly name: string;
  /** Wire external event sources to the inbox. Idempotent per wake. */
  start?(inbox: Inbox): void | Promise<void>;
  readonly outbound?: Outbox;
}

// ---------------------------------------------------------------------------
// Realtime escape hatch (redesign deferred)
// ---------------------------------------------------------------------------

/**
 * A live media session (voice, screen share). Frames never touch the log;
 * when something semantically happened (a transcription, a turn taken, a
 * summary), the session commits it through the inbox like any other inbound
 * event. This shape is intentionally left unchanged pending the realtime
 * design decision.
 */
export interface RealtimeSession {
  readonly id: string;
  close(): Promise<void>;
}
