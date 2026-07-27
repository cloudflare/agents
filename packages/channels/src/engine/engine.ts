import type { UIMessage, UIMessageChunk } from "ai";
import type { TurnRecord } from "../storage/store";
import {
  isTurnInterruptedError,
  isTurnPause,
  TurnInterruptedError,
  type AgentConnector,
  type ConnectorTurn,
  type ConversationStateStore,
  type JournalEntry,
  type TurnOrigin,
  type TurnOutcome,
  type TurnPause
} from "../types";
import type { TurnEngineHost } from "./host";
import { openPartEnds, planResume } from "./resume";
import { assertTransition, type TurnState } from "./turn-state";

/** Journals of settled turns are pruned after 24 hours. Not configurable. */
export const JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The journal chunk type the engine appends when a turn pauses, carrying
 * the pending interaction to clients: `{ id, kind, payload }`. Web and
 * journal consumers may use it to render or route approvals.
 */
export const INTERACTION_CHUNK_TYPE = "data-channels-interaction";
export const INTERACTION_COMPLETION_CHUNK_TYPE =
  "data-channels-interaction-completion";

/**
 * One host-normalized event admitted to the durable ledger.
 */
export interface InboundTurnEvent {
  /** Stable host-defined scope for ordering and connector state. */
  conversationId: string;
  /** Event identity local to this conversation. Omit for non-redeliverable work. */
  sourceEventId?: string;
  input: UIMessage[];
  origin?: TurnOrigin;
  principal?: string;
  /**
   * Completes a pending human interaction: the event joins the paused turn
   * instead of opening a new one. Duplicate completions absorb like any
   * redelivered source event. When `value` is omitted, the event's `input` becomes
   * the interaction value (the inbound reply *is* the answer).
   */
  interaction?: { id: string; value?: unknown };
}

export type Admission =
  /** A fresh turn was admitted and is now executing. */
  | { kind: "new"; turn: TurnRecord }
  /** Duplicate of an in-flight turn — same turn, no second execution. */
  | { kind: "joined"; turn: TurnRecord }
  /** Duplicate of a settled turn or a stale completion; no work started. */
  | { kind: "absorbed"; turn?: TurnRecord }
  /** A completion re-entered a WAITING turn. */
  | { kind: "resumed"; turn: TurnRecord };

/**
 * How the recovery scan resolved a turn. `waiting` means the ledger was
 * left alone because the human interaction is durably parked.
 */
export type RecoveryResolution = "rerun" | "resumed" | "apologized" | "waiting";

export interface TurnEngineOptions {
  host: TurnEngineHost;
  connector: AgentConnector;
  /** Host-provided guidance for a conversation scope. */
  guidance?: (conversationId: string) => string | undefined;
  /**
   * Called after the engine resolves each recovered turn. The host may use
   * this to restart journal consumption or record recovery telemetry.
   */
  onRecovered?: (turn: TurnRecord, resolution: RecoveryResolution) => void;
}

export interface TurnEngine {
  submit(event: InboundTurnEvent): Promise<Admission>;
  cancelTurn(turnId: string, reason?: string): Promise<TurnRecord | undefined>;
  getTurn(turnId: string): TurnRecord | undefined;
  openJournal(turnId: string, fromSeq?: number): AsyncGenerator<JournalEntry>;
  waitForSettlement(turnId: string): Promise<TurnRecord>;
  onWake(): Promise<void>;
}

/**
 * A durable turn engine backed by a ledger and append-only output journal.
 * One admitted event becomes one turn, and each turn settles exactly once.
 * Execution is at least once; journal entries are committed exactly once.
 *
 * The engine sees its environment only through {@link TurnEngineHost}. It knows
 * nothing about HTTP, transports, delivery surfaces, or presentation. Recovery
 * scans durable state before the first event in each isolate lifetime.
 *
 * Running turns in one conversation are serialized in admission order. A turn
 * parked on a human interaction releases the execution slot; its continuation
 * queues against whatever is running when the completion arrives.
 */
export class DurableTurnEngine implements TurnEngine {
  private readonly host: TurnEngineHost;
  private readonly connector: AgentConnector;
  private readonly options: TurnEngineOptions;

  /** Tail of each conversation's execution chain, by conversation id. */
  private readonly conversationChains = new Map<string, Promise<void>>();
  /** Turns queued or executing in this isolate, by turn id. */
  private readonly scheduled = new Set<string>();
  /** Abort controllers of turns actually executing right now. */
  private readonly executing = new Map<string, AbortController>();
  /** Wakers for journal followers and settlement waiters, by turn id. */
  private readonly waiters = new Map<string, Set<() => void>>();
  private recovery?: Promise<void>;

  constructor(options: TurnEngineOptions) {
    this.host = options.host;
    this.connector = options.connector;
    this.options = options;
  }

  // ── Ingress ─────────────────────────────────────────────────────────

  /**
   * Admit one inbound event: a new turn, a join onto an in-flight or
   * settled duplicate, or a completion re-entering a WAITING turn. New and
   * re-entered turns start executing in the background under
   * `host.holdWhile`.
   */
  async submit(event: InboundTurnEvent): Promise<Admission> {
    await this.ensureRecovered();
    if (event.interaction) {
      return this.completeInteraction(event);
    }

    const store = this.host.storage;
    const now = this.host.now();

    const admission = store.transaction((): Admission => {
      const existing = event.sourceEventId
        ? store.findTurnBySourceEvent(event.conversationId, event.sourceEventId)
        : undefined;
      if (existing) {
        return existing.state === "settled"
          ? { kind: "absorbed", turn: existing }
          : { kind: "joined", turn: existing };
      }
      const turn = store.insertTurn({
        at: now,
        conversationId: event.conversationId,
        sourceEventId: event.sourceEventId ?? null,
        id: crypto.randomUUID(),
        input: event.input,
        origin: event.origin ?? "inbound",
        principal: event.principal ?? null
      });
      return { kind: "new", turn };
    });

    if (admission.kind === "new") {
      this.start(admission.turn);
    }
    return admission;
  }

  private completeInteraction(event: InboundTurnEvent): Admission {
    const completion = event.interaction!;
    const store = this.host.storage;
    const now = this.host.now();

    const admission = store.transaction((): Admission => {
      const interaction = store.getInteraction(completion.id);
      if (!interaction || interaction.status === "completed") {
        return { kind: "absorbed" };
      }
      const turn = store.getTurn(interaction.turnId);
      // Interaction ids are opaque handles, not cross-conversation
      // capabilities. Hosts decide who may answer within one conversation.
      if (
        !turn ||
        turn.conversationId !== event.conversationId ||
        turn.state !== "waiting"
      ) {
        return { kind: "absorbed", turn };
      }
      const value = completion.value ?? event.input;
      store.completeInteraction(completion.id, value, now);
      store.appendChunk(turn.id, {
        data: { id: completion.id, value },
        type: INTERACTION_COMPLETION_CHUNK_TYPE
      } as unknown as UIMessageChunk);
      const resumed = this.moveTurn(turn.id, "waiting", "accepted", {
        at: now,
        // Include the completion event at the start of the next segment.
        continuationFromSeq: turn.nextSeq
      });
      if (!resumed) {
        return { kind: "absorbed", turn };
      }
      return { kind: "resumed", turn: resumed };
    });

    if (admission.kind === "resumed") {
      this.start(admission.turn);
    }
    return admission;
  }

  /**
   * Cancel a turn: the ordinary abort path (a barge-in, a user "stop", an
   * abandoned approval). A running turn's connector is aborted and the
   * engine stops consuming it regardless of whether the connector honors
   * the signal; a parked or queued turn settles directly. Either way the
   * turn settles `interrupted` — one visible outcome, like every turn.
   * Resolves with the settled record; cancelling a settled turn is a
   * no-op.
   */
  async cancelTurn(
    turnId: string,
    reason = "The turn was cancelled"
  ): Promise<TurnRecord | undefined> {
    await this.ensureRecovered();
    const turn = this.host.storage.getTurn(turnId);
    if (!turn || turn.state === "settled") {
      return turn;
    }
    const controller = this.executing.get(turnId);
    if (controller) {
      controller.abort(reason);
      return this.waitForSettlement(turnId);
    }
    // WAITING, queued behind another turn, or orphaned by a crash: settle
    // now; a queued execution will see the settled row and no-op.
    this.settle(turnId, "interrupted", reason);
    return this.host.storage.getTurn(turnId);
  }

  // ── Recovery ────────────────────────────────────────────────────────

  /**
   * The ledger-driven recovery scan, run once per isolate lifetime before
   * any event is processed. Reads every non-terminal turn and resolves it
   * by state: `accepted` re-runs, `streaming` resumes (connector
   * capability) or settles as interrupted, `waiting` keeps its durable
   * wait and reports it through the recovery callback.
   */
  ensureRecovered(): Promise<void> {
    this.recovery ??= Promise.resolve()
      .then(() => this.recover())
      .catch((error: unknown) => {
        // Never cache a failed scan — that would brick the engine on a
        // transient storage error. The next event retries it.
        this.recovery = undefined;
        throw error;
      });
    return this.recovery;
  }

  private recover(): void {
    const store = this.host.storage;
    for (const turn of store.listUnsettledTurns()) {
      if (this.scheduled.has(turn.id)) {
        continue;
      }
      switch (turn.state) {
        case "waiting":
          this.options.onRecovered?.(turn, "waiting");
          break;
        case "accepted":
          this.start(turn);
          this.options.onRecovered?.(turn, "rerun");
          break;
        case "streaming":
          if (this.connector.capabilities?.resume) {
            this.start(turn);
            this.options.onRecovered?.(turn, "resumed");
          } else {
            this.settle(
              turn.id,
              "interrupted",
              "The turn engine restarted while output was streaming"
            );
            const settled = store.getTurn(turn.id);
            if (settled) {
              this.options.onRecovered?.(settled, "apologized");
            }
          }
          break;
        case "settled":
          // Unreachable: listUnsettledTurns excludes settled rows. Present
          // so the switch stays exhaustive over TurnState.
          break;
      }
    }
    this.armRetentionWake();
  }

  // ── Execution ───────────────────────────────────────────────────────

  /**
   * Queue a turn's execution on its conversation's chain. Queuing the
   * same turn twice is a no-op; executing a turn that has since settled
   * is a no-op — so double-scheduling is harmless, never double-running.
   */
  private start(turn: TurnRecord): void {
    if (this.scheduled.has(turn.id)) {
      return;
    }
    this.scheduled.add(turn.id);
    const previous =
      this.conversationChains.get(turn.conversationId) ?? Promise.resolve();
    const run = previous
      .then(() => this.executeTurn(turn.id))
      .catch(() => {
        // executeTurn settles its own failures; a throw here means the
        // store itself failed — the recovery scan will resolve the turn.
      })
      .finally(() => {
        this.scheduled.delete(turn.id);
        if (this.conversationChains.get(turn.conversationId) === run) {
          this.conversationChains.delete(turn.conversationId);
        }
      });
    this.conversationChains.set(turn.conversationId, run);
    void this.host.holdWhile(run);
  }

  private async executeTurn(turnId: string): Promise<void> {
    const store = this.host.storage;
    let turn = store.getTurn(turnId);
    if (!turn || turn.state === "settled" || turn.state === "waiting") {
      return;
    }

    turn = this.prepareJournalForRun(turn);
    const filter = this.chunkFilterForRun(turn);

    const abort = new AbortController();
    this.executing.set(turnId, abort);

    const connectorTurn: ConnectorTurn = {
      conversationId: turn.conversationId,
      guidance: this.options.guidance?.(turn.conversationId),
      id: turn.id,
      input: turn.input,
      interactions: store.listCompletedInteractions(turn.id),
      origin: turn.origin,
      principal: turn.principal ?? undefined,
      signal: abort.signal,
      state: this.conversationState(turn.conversationId)
    };

    // Consumption races the abort signal, so cancellation lands even when
    // a connector ignores its signal: the engine stops pulling, settles
    // interrupted, and the orphaned generator is closed best-effort.
    const iterator = this.connector.run(connectorTurn)[Symbol.asyncIterator]();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          new TurnInterruptedError(
            typeof abort.signal.reason === "string"
              ? abort.signal.reason
              : "The turn was cancelled"
          )
        );
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);

    let state: TurnState = turn.state;
    try {
      while (true) {
        const pulled = iterator.next();
        // If the abort wins the race, this orphaned pull may still reject
        // later (the connector noticing its signal) — that rejection is
        // already accounted for and must not surface as unhandled.
        pulled.catch(() => undefined);
        const next = await Promise.race([pulled, aborted]);
        if (next.done) {
          break;
        }
        for (const chunk of filter(next.value)) {
          state = this.journalChunk(turnId, state, chunk);
        }
      }
      this.settle(turnId, "ok");
    } catch (error) {
      if (isTurnPause(error)) {
        this.pause(turnId, error);
      } else if (isTurnInterruptedError(error)) {
        this.settle(turnId, "interrupted", describeError(error));
      } else {
        this.settle(turnId, "error", describeError(error));
      }
    } finally {
      this.executing.delete(turnId);
      if (onAbort) {
        abort.signal.removeEventListener("abort", onAbort);
      }
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
    }
  }

  /**
   * Ready the journal for a (re-)run. An `accepted` turn that has never
   * streamed drops any stale invisible frames — nothing was visible, so a
   * re-run starts clean. A journal with visible content keeps every byte
   * and gets its crash-opened parts closed, so replay stays well-formed.
   */
  private prepareJournalForRun(turn: TurnRecord): TurnRecord {
    const store = this.host.storage;
    if (turn.nextSeq === 0) {
      return turn;
    }
    if (turn.state === "accepted" && turn.continuationFromSeq === 0) {
      store.clearChunks(turn.id);
    } else {
      for (const end of openPartEnds(store.listChunks(turn.id, 0))) {
        store.appendChunk(turn.id, end);
      }
    }
    return store.getTurn(turn.id) ?? turn;
  }

  /**
   * A replay-style connector (declared `resume`) re-emits an overlap of
   * chunks the journal already holds; filter them out so every visible
   * byte is journaled exactly once. Re-runs that generate fresh content
   * (everything else) pass through untouched.
   */
  private chunkFilterForRun(
    turn: TurnRecord
  ): (chunk: UIMessageChunk) => UIMessageChunk[] {
    if (
      turn.state === "streaming" &&
      turn.nextSeq > 0 &&
      this.connector.capabilities?.resume
    ) {
      const journal = this.host.storage.listChunks(turn.id, 0);
      return planResume(journal).filter;
    }
    return (chunk) => [chunk];
  }

  /** Append one chunk; the first content chunk moves the turn to STREAMING. */
  private journalChunk(
    turnId: string,
    state: TurnState,
    chunk: UIMessageChunk
  ): TurnState {
    const store = this.host.storage;
    let next = state;
    store.transaction(() => {
      // A superseded writer (this execution outlived a settle by another
      // party — possible only in tests' kill simulation, but cheap to
      // forbid) must never extend a settled journal.
      if (store.getTurn(turnId)?.state === "settled") {
        throw new TurnInterruptedError("The turn settled elsewhere");
      }
      if (state === "accepted" && isContentChunk(chunk)) {
        this.moveTurn(turnId, "accepted", "streaming", {
          at: this.host.now()
        });
        next = "streaming";
      }
      store.appendChunk(turnId, chunk);
    });
    this.notify(turnId);
    return next;
  }

  private pause(turnId: string, pauseSignal: TurnPause): void {
    const store = this.host.storage;
    const now = this.host.now();
    store.transaction(() => {
      const turn = store.getTurn(turnId);
      if (!turn || turn.state === "settled" || turn.state === "waiting") {
        return;
      }
      for (const end of openPartEnds(store.listChunks(turnId, 0))) {
        store.appendChunk(turnId, end);
      }
      const interaction = {
        id: pauseSignal.interaction.id ?? crypto.randomUUID(),
        kind: pauseSignal.interaction.kind,
        payload: pauseSignal.interaction.payload
      };
      // Re-pausing on an id reuses (and re-opens) the interaction row, so
      // connectors may use stable, meaningful ids without wedging a turn.
      store.upsertInteraction({ ...interaction, at: now, turnId });
      // Journal the pause so clients see it in-stream and on replay.
      store.appendChunk(turnId, {
        data: interaction,
        type: INTERACTION_CHUNK_TYPE
      } as unknown as UIMessageChunk);
      this.moveTurn(turnId, turn.state, "waiting", { at: now });
    });
    this.notify(turnId);
  }

  private settle(
    turnId: string,
    outcome: TurnOutcome,
    errorText?: string
  ): void {
    const store = this.host.storage;
    const now = this.host.now();
    const settled = store.transaction(() => {
      const turn = store.getTurn(turnId);
      if (!turn || turn.state === "settled") {
        return undefined;
      }
      for (const end of openPartEnds(store.listChunks(turnId, 0))) {
        store.appendChunk(turnId, end);
      }
      return this.moveTurn(turnId, turn.state, "settled", {
        at: now,
        errorText,
        outcome
      });
    });
    if (settled) {
      this.host.wake(now + JOURNAL_RETENTION_MS);
      this.notify(turnId);
    }
  }

  /**
   * The one door through which a turn changes state: the machine's check
   * (assertTransition) and the store's compare-and-set, together. Returns
   * undefined when the row had already moved on.
   */
  private moveTurn(
    turnId: string,
    from: TurnState,
    to: TurnState,
    patch: {
      at: number;
      outcome?: TurnOutcome;
      errorText?: string;
      continuationFromSeq?: number;
    }
  ): TurnRecord | undefined {
    assertTransition(turnId, from, to);
    return this.host.storage.transitionTurn(turnId, from, to, patch);
  }

  // ── Reads ───────────────────────────────────────────────────────────

  getTurn(turnId: string): TurnRecord | undefined {
    return this.host.storage.getTurn(turnId);
  }

  /**
   * Replay a turn's journal from `fromSeq` and follow live appends until
   * the turn parks (WAITING) or settles. Consumers choose how to present,
   * persist, or forward the committed entries.
   */
  async *openJournal(
    turnId: string,
    fromSeq = 0
  ): AsyncGenerator<JournalEntry> {
    await this.ensureRecovered();
    const store = this.host.storage;
    let seq = fromSeq;
    while (true) {
      for (const entry of store.listChunks(turnId, seq)) {
        seq = entry.seq + 1;
        yield entry;
      }
      const turn = store.getTurn(turnId);
      if (!turn) {
        return;
      }
      if (turn.state === "settled" || turn.state === "waiting") {
        // Drain appends that raced the state read; parking and settling
        // both append (part ends) before the transition commits.
        for (const entry of store.listChunks(turnId, seq)) {
          seq = entry.seq + 1;
          yield entry;
        }
        return;
      }
      await this.nextChange(turnId);
    }
  }

  /** Resolve when the turn settles. A WAITING turn keeps this pending. */
  async waitForSettlement(turnId: string): Promise<TurnRecord> {
    await this.ensureRecovered();
    while (true) {
      const turn = this.host.storage.getTurn(turnId);
      if (!turn) {
        throw new Error(`Unknown turn ${turnId}`);
      }
      if (turn.state === "settled") {
        return turn;
      }
      await this.nextChange(turnId);
    }
  }

  /** Durable per-conversation KV used by connectors (sessions, offsets). */
  private conversationState(conversationId: string): ConversationStateStore {
    const store = this.host.storage;
    return {
      delete: async (key) => {
        store.kvDelete(conversationId, key);
      },
      get: async <T>(key: string) => {
        return store.kvGet(conversationId, key) as T | undefined;
      },
      set: async (key, value) => {
        store.kvSet(conversationId, key, value);
      }
    };
  }

  // ── Timers ──────────────────────────────────────────────────────────

  /**
   * Handle a (possibly spurious) durable wake: prune expired journals and
   * re-arm the next retention wake.
   */
  async onWake(): Promise<void> {
    await this.ensureRecovered();
    this.host.storage.pruneChunks(this.host.now() - JOURNAL_RETENTION_MS);
    this.armRetentionWake();
  }

  private armRetentionWake(): void {
    const earliest = this.host.storage.earliestPrunableSettledAt();
    if (earliest !== undefined) {
      this.host.wake(earliest + JOURNAL_RETENTION_MS);
    }
  }

  // ── Change notification ─────────────────────────────────────────────

  private notify(turnId: string): void {
    const waiters = this.waiters.get(turnId);
    if (!waiters) {
      return;
    }
    this.waiters.delete(turnId);
    for (const wake of waiters) {
      wake();
    }
  }

  private nextChange(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      let waiters = this.waiters.get(turnId);
      if (!waiters) {
        waiters = new Set();
        this.waiters.set(turnId, waiters);
      }
      waiters.add(resolve);
    });
  }
}

/**
 * Chunks that put content in front of a user. The first one moves the turn
 * to STREAMING; protocol frames (`text-start`, `finish-step`, …) do not.
 */
function describeError(error: unknown): string {
  if (error === null || error === undefined) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  const candidate = error as { message?: unknown };
  return typeof candidate.message === "string"
    ? candidate.message
    : JSON.stringify(error);
}

export function isContentChunk(chunk: UIMessageChunk): boolean {
  const { type } = chunk;
  if (type === "text-delta" || type === "reasoning-delta") {
    return (chunk as { delta?: string }).delta !== "";
  }
  return (
    type.startsWith("tool-") ||
    type.startsWith("data-") ||
    type === "file" ||
    type === "source-url" ||
    type === "source-document" ||
    type === "error"
  );
}
