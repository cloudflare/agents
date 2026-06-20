/**
 * AutoContinuationController — shared auto-continuation barrier for the
 * tool-result → auto-continue flow (#1649 / #1650).
 *
 * Both `@cloudflare/ai-chat` (`AIChatAgent`) and `@cloudflare/think` (`Think`)
 * drive an identical event-driven barrier: a tool result/approval that opts in
 * with `autoContinue` schedules a continuation, rapid sibling results coalesce
 * into a single fire via a debounce timer, and the actual fire is gated on a
 * complete parallel tool batch and no active stream. This controller owns that
 * machinery exactly once:
 *
 * - the coalesce/debounce timer ({@link AutoContinuationController.COALESCE_MS}),
 * - the `barrierActive` double-fire guard,
 * - the create/update/defer scheduling branch ({@link schedule}),
 * - the completeness-gated drain orchestration ({@link fireWhenStable}).
 *
 * Everything host-specific is expressed through {@link AutoContinuationHost}: the
 * stream-active signal, the incomplete-batch / pending-interaction predicates,
 * the apply-drain primitive, and the actual continuation turn ({@link
 * AutoContinuationHost.fire}, each host's inference/reply pipeline). The shared
 * {@link ContinuationState} data layer stays on the host and is read/mutated
 * here through {@link AutoContinuationHost.continuation}.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { ClientToolSchema } from "./client-tools";
import type {
  ContinuationConnection,
  ContinuationState
} from "./continuation-state";

/**
 * The data a host supplies to schedule (or re-target) a pending/deferred
 * auto-continuation. Mirrors the fields a host writes onto
 * {@link ContinuationState.pending} — the host owns where the values come from
 * (e.g. Think hardcodes a fixed `errorPrefix` and `body: undefined`; ai-chat
 * threads them per tool-result event).
 */
export interface ContinuationSpec<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  connection: TConnection;
  clientTools: ClientToolSchema[] | undefined;
  body: Record<string, unknown> | undefined;
  errorPrefix: string;
}

/**
 * Host substrate the controller parameterizes over. Implemented by the agent
 * (typically via a small adapter object capturing `this`).
 */
export interface AutoContinuationHost<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  /** Shared continuation state (pending/deferred/awaiting connections). */
  readonly continuation: ContinuationState<TConnection>;
  /** Generate a request id for a freshly-created continuation turn. */
  generateRequestId(): string;
  /**
   * `true` while an assistant turn is streaming — the parallel tool batch can
   * still grow with tool calls the model hasn't emitted yet, so no completeness
   * check is meaningful. (`_streamingAssistant !== null` in Think;
   * `_streamingTurnActive` in ai-chat.)
   */
  isStreamActive(): boolean;
  /** `true` while a tool-result/approval apply is in flight. */
  hasPendingInteraction(): boolean;
  /**
   * `true` when the latest assistant message is mid-batch (a settled tool
   * result beside an unanswered tool call/approval — the #1649 signature).
   */
  hasIncompleteToolBatch(): boolean;
  /**
   * Drain every in-flight tool-result/approval apply (including any enqueued
   * while draining) so the subsequent completeness re-check sees every result
   * that has already arrived. Bounded by real apply activity, never a timer.
   */
  drainInteractionApplies(): Promise<void>;
  /** Hold the isolate alive for the duration of `fn` (alarm heartbeats). */
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run the continuation turn for the current {@link ContinuationState.pending}.
   * Each host's inference/reply pipeline (Think: `_turnQueue.enqueue` +
   * `_runInferenceLoop`; ai-chat: `_runExclusiveChatTurn` + `onChatMessage`).
   * Reads everything it needs from `continuation.pending`, so it takes no args.
   */
  fire(): void;
}

export class AutoContinuationController<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  /**
   * Small debounce window to batch adjacent client-side tool results/approvals
   * into a single server continuation barrier check (#1650).
   */
  static readonly COALESCE_MS = 50;

  /**
   * Coalesce/debounce timer for the event-driven barrier (#1650). Each tool
   * result/approval re-arms it; on fire it runs {@link fireWhenStable}.
   */
  private _timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Double-fire guard (#1650). Ensures only one in-flight apply-drain runs;
   * that drain re-checks completeness on completion before firing. A sibling
   * that re-arms the coalesce timer during a drain is absorbed by the
   * in-progress drain rather than starting its own.
   */
  private _barrierActive = false;

  constructor(private readonly host: AutoContinuationHost<TConnection>) {}

  /**
   * Schedule an auto-continuation for a tool result/approval that opted in with
   * `autoContinue` (#1650). Coalesces rapid sibling results into a single
   * continuation via the debounce timer; the actual fire is gated by
   * {@link fireWhenStable}. If a continuation is already running
   * (`pastCoalesce`), the new result is stored as the deferred follow-up
   * instead of re-arming.
   */
  schedule(spec: ContinuationSpec<TConnection>): void {
    const c = this.host.continuation;

    if (c.pending?.pastCoalesce) {
      // A continuation is already running; the new result coalesces/defers into
      // the next one rather than re-arming this one.
      c.deferred = {
        connection: spec.connection,
        connectionId: spec.connection.id,
        clientTools: spec.clientTools,
        body: spec.body,
        errorPrefix: spec.errorPrefix,
        prerequisite: null
      };
      return;
    }

    if (c.pending) {
      c.pending.connection = spec.connection;
      c.pending.connectionId = spec.connection.id;
      c.pending.clientTools = spec.clientTools;
      c.pending.body = spec.body;
      c.pending.errorPrefix = spec.errorPrefix;
      c.awaitingConnections.set(spec.connection.id, spec.connection);
      this.armTimer();
      return;
    }

    c.pending = {
      connection: spec.connection,
      connectionId: spec.connection.id,
      requestId: this.host.generateRequestId(),
      clientTools: spec.clientTools,
      body: spec.body,
      errorPrefix: spec.errorPrefix,
      prerequisite: null,
      pastCoalesce: false
    };
    c.awaitingConnections.set(spec.connection.id, spec.connection);
    this.armTimer();
  }

  /**
   * Re-arm the barrier for a result/approval that arrived WITHOUT `autoContinue`
   * (#1650). A standalone errored result declines to continue on its own, but in
   * a parallel batch a SIBLING may already have opted in — and this result can
   * be the one that completes the batch, so we must re-run the barrier check.
   * Unlike {@link schedule} this NEVER creates a pending continuation, and
   * no-ops once the continuation is running (`pastCoalesce`).
   */
  rearmForBatch(): void {
    const pending = this.host.continuation.pending;
    if (!pending || pending.pastCoalesce) return;
    this.armTimer();
  }

  /** (Re)arm the coalesce timer; on fire, run {@link fireWhenStable}. */
  armTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this.host.continuation.pending) return;
      this.fireWhenStable();
    }, AutoContinuationController.COALESCE_MS);
  }

  /**
   * Fire an auto-continuation, but only once the model's parallel tool-call
   * batch is fully answered (#1649) and no assistant turn is mid-stream (#1650).
   * The barrier is event-driven with NO orphan timeout: when the batch is still
   * incomplete we drain the in-flight applies, re-check, and — if still
   * incomplete — return WITHOUT firing and WITHOUT holding the isolate, leaving
   * `continuation.pending` in place. The next sibling's result re-arms the
   * coalesce timer and re-runs this check; the continuation fires once the final
   * sibling lands. A true orphan (a sibling that never arrives) simply never
   * auto-continues — a later user turn / chat recovery repairs the transcript.
   */
  fireWhenStable(): void {
    const c = this.host.continuation;
    if (!c.pending) return;
    // The continuation is already running (a sibling re-armed after it started).
    // New results coalesce/defer into it — don't double-fire.
    if (c.pending.pastCoalesce) return;
    // A drain is already in progress; the sibling that re-armed the timer is
    // absorbed by it. Only one drain runs, and it re-checks on completion.
    if (this._barrierActive) return;
    // Stream-active gate (#1650, #1649): while the model is still streaming the
    // assistant turn we cannot know the parallel batch is complete — a fast
    // client tool can resolve before its slower siblings have even been
    // streamed, so they exist nowhere yet and firing now would repair them to
    // errored. The stream-finalize hook re-runs this check once the stream ends.
    if (this.host.isStreamActive()) return;
    // Fast path: no apply in flight and the leaf step is not mid-batch.
    if (
      !this.host.hasPendingInteraction() &&
      !this.host.hasIncompleteToolBatch()
    ) {
      this.cancelTimer();
      this.host.fire();
      return;
    }
    this._barrierActive = true;
    // keepAlive only for the bounded drain — the duration of the applies that
    // have ALREADY arrived, not an open-ended wait for siblings that haven't.
    this.host
      .keepAliveWhile(() => this.host.drainInteractionApplies())
      .catch(() => {})
      .finally(() => {
        // Clear the flag and re-check synchronously — no `await` between here
        // and the fire/return decision, so a sibling-armed coalesce timer (a
        // macrotask) cannot interleave and double-fire. `cancelTimer()` below
        // kills that timer on the fire path; the incomplete-return path leaves
        // it armed so the sibling that armed it re-runs this check.
        this._barrierActive = false;
        const pending = c.pending;
        if (!pending || pending.pastCoalesce) return;
        // A stream (re)started during the drain — hold; the finalize re-trigger
        // re-checks once the batch is fully materialized.
        if (this.host.isStreamActive()) return;
        // Still waiting on an unanswered sibling — return without firing. The
        // result that completes the batch re-triggers this via its own
        // schedule(); we do not pin the isolate in the interim.
        if (this.host.hasIncompleteToolBatch()) return;
        this.cancelTimer();
        this.host.fire();
      });
  }

  /**
   * Transition the deferred follow-up (stored while a continuation was running)
   * to pending and re-run the barrier — its batch may still be incomplete (or a
   * stream active), in which case it parks and re-arms instead of firing blind.
   */
  activateDeferredAndReschedule(): void {
    const pending = this.host.continuation.activateDeferred(() =>
      this.host.generateRequestId()
    );
    if (!pending) return;
    this.fireWhenStable();
  }

  /**
   * Cancel any still-armed coalesce timer. Called on the fire path so a sibling
   * result that re-armed it during a barrier wait can't fire a duplicate
   * continuation after this one starts (#1649 / #1650).
   */
  cancelTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * `true` when the barrier is going to fire on its own — its coalesce timer is
   * still pending or its completeness drain is in progress. The host combines
   * this with its own pending/`pastCoalesce` checks to decide idle/stable.
   */
  isArmed(): boolean {
    return this._timer !== null || this._barrierActive;
  }

  /**
   * Tear down the controller-owned barrier state (timer + double-fire guard).
   * Scoped to ONLY this controller's fields — the host clears the rest of its
   * turn state (stream gate, interaction tail, continuation data) separately.
   */
  reset(): void {
    this.cancelTimer();
    this._barrierActive = false;
  }
}
