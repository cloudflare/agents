/**
 * The chat turn queue on an Inbox lane.
 *
 * Every turn is a request on one lane of the chat core's own inbox
 * (`cf_agents_inbox__chat`), so turns run one at a time in arrival order
 * and the record of a turn waiting to run survives the isolate. The turn's
 * closure rides beside the record as its `local` value: it runs in the
 * async context of the call that enqueued it. After a reset a record has no
 * closure; {@link ChatLaneOptions.replay} decides what it does then.
 *
 * The surface is the one the hosts already use (`generation`,
 * `activeRequestId`, `enqueue(requestId, fn, { generation })`, `reset`,
 * `waitForIdle`, `queuedCount`), so a host's admission wrapper does not
 * change.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  Inbox,
  type InboxRequest,
  type InboxRun,
  type InboxSettlement
} from "../inbox";

/** What a queued turn ended as, as `TurnQueue` reported it. */
export type LaneTurnResult<T> =
  | { status: "completed"; value: T }
  | { status: "stale" };

/** What a turn's record carries. JSON. */
export type ChatLanePayload = {
  /** The request id the turn answers. */
  requestId: string;
  /** Data the host needs to run the turn again after a reset. */
  replay?: unknown;
};

/** The closure and bookkeeping a turn keeps in memory beside its record. */
type LaneTurn = {
  readonly requestId: string;
  readonly generation: number;
  readonly run: () => Promise<unknown>;
  readonly resolve: (result: LaneTurnResult<unknown>) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  /** Its closure began: it ends with the closure, a clear or not. */
  started: boolean;
};

/** @internal */
export interface ChatLaneOptions {
  /**
   * A turn found after a reset, with no closure: run it again from its
   * record, or end it. Defaults to ending it `skipped`.
   */
  replay?(
    payload: ChatLanePayload,
    run: InboxRun
  ): Promise<InboxSettlement | void>;
}

const LANE = "chat";

/** @internal */
export class ChatLane {
  /** Install with `Lifecycle.use()`; its rows are the chat core's own. */
  readonly inbox: Inbox<{
    turn: (payload: ChatLanePayload, run: InboxRun) => Promise<unknown>;
  }>;
  #generation = 0;
  #active: { requestId: string; generation: number } | null = null;
  readonly #counts = new Map<number, number>();
  readonly #idle = new Set<() => void>();
  readonly #replay: ChatLaneOptions["replay"];

  constructor(options: ChatLaneOptions = {}) {
    this.#replay = options.replay;
    this.inbox = new Inbox({
      name: "chat",
      retain: false,
      // A turn's own recovery budgets decide when an interrupted turn gives
      // up, not a count of runs.
      maxAttempts: Number.MAX_SAFE_INTEGER,
      handlers: { turn: (payload, run) => this.#run(payload, run) },
      onStatus: (request) => this.#onStatus(request)
    });
  }

  /** The chat's reset epoch. */
  get generation(): number {
    return this.#generation;
  }

  get activeRequestId(): string | null {
    return this.#active?.requestId ?? null;
  }

  /** The generation the running turn was admitted under, or `null`. */
  get activeGeneration(): number | null {
    return this.#active?.generation ?? null;
  }

  get isActive(): boolean {
    return this.#active !== null;
  }

  /** Turns queued or running under `generation` (default: the current one). */
  queuedCount(generation = this.#generation): number {
    return this.#counts.get(generation) ?? 0;
  }

  /**
   * Queue a turn. It runs once every turn before it ended, in the async
   * context of this call. A turn whose generation a reset passed before it
   * started does not run: `{ status: "stale" }`.
   */
  enqueue<T>(
    requestId: string,
    fn: () => Promise<T>,
    options: { generation?: number; replay?: unknown } = {}
  ): Promise<LaneTurnResult<T>> {
    const generation = options.generation ?? this.#generation;
    this.#counts.set(generation, this.queuedCount(generation) + 1);
    const inCaller = AsyncLocalStorage.snapshot();
    const id = crypto.randomUUID();
    return new Promise<LaneTurnResult<T>>((resolve, reject) => {
      const turn: LaneTurn = {
        requestId,
        generation,
        run: () => inCaller(fn),
        resolve: (result) => {
          if (turn.settled) return;
          turn.settled = true;
          this.#pendingTurns.delete(id);
          this.#done(generation);
          resolve(result as LaneTurnResult<T>);
        },
        reject: (error) => {
          if (turn.settled) return;
          turn.settled = true;
          this.#pendingTurns.delete(id);
          this.#done(generation);
          reject(error);
        },
        settled: false,
        started: false
      };
      this.#pendingTurns.set(id, turn);
      this.inbox
        .submit(
          "turn",
          {
            requestId,
            ...(options.replay !== undefined && { replay: options.replay })
          },
          { id, lane: LANE, start: "now", local: turn }
        )
        .catch(turn.reject);
    });
  }

  /** Invalidate every queued turn: they end `stale` without running. */
  reset(): void {
    this.#generation++;
    void this.inbox.clear(LANE, "reset").catch((error: unknown) => {
      console.error("[chat] failed to clear the turn lane", error);
    });
  }

  /** Resolve once no turn is queued or running. */
  async waitForIdle(): Promise<void> {
    while (this.#total() > 0) {
      await new Promise<void>((resolve) => this.#idle.add(resolve));
    }
  }

  async #run(payload: ChatLanePayload, run: InboxRun): Promise<unknown> {
    const turn = run.local as LaneTurn | undefined;
    if (!turn) {
      // Found after a reset: the closure is gone.
      return (await this.#replay?.(payload, run)) ?? Inbox.skipped("reset");
    }
    if (turn.generation !== this.#generation) {
      turn.resolve({ status: "stale" });
      return Inbox.skipped("stale");
    }
    turn.started = true;
    this.#active = { requestId: turn.requestId, generation: turn.generation };
    try {
      const value = await turn.run();
      turn.resolve({ status: "completed", value });
      return undefined;
    } catch (error) {
      turn.reject(error);
      return Inbox.failed(error);
    } finally {
      this.#active = null;
    }
  }

  /** A turn that ended without running (a clear) is stale to its caller. */
  #onStatus(request: InboxRequest): void {
    if (request.status === "pending" || request.status === "running") return;
    // The record's local value is gone once the report returns; the turn's
    // promise settles here at the latest.
    const turn = this.#pendingTurns.get(request.id);
    if (turn && !turn.started) turn.resolve({ status: "stale" });
  }

  readonly #pendingTurns = new Map<string, LaneTurn>();

  #done(generation: number): void {
    const count = this.queuedCount(generation) - 1;
    if (count > 0) this.#counts.set(generation, count);
    else this.#counts.delete(generation);
    if (this.#total() === 0) {
      for (const wake of [...this.#idle]) {
        this.#idle.delete(wake);
        wake();
      }
    }
  }

  #total(): number {
    let total = 0;
    for (const count of this.#counts.values()) total += count;
    return total;
  }
}
