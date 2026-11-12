/**
 * AgentToolRuns — the life of an agent-tool run on the child agent, shared
 * by `@cloudflare/ai-chat` (`AIChatAgent`) and `@cloudflare/think` (`Think`).
 *
 * A parent agent runs a chat agent as a tool: it starts a run, follows the
 * run's frames, and reads the run's terminal status from a row the child
 * keeps. Each host used to write that lifecycle itself, with rules that
 * differed at the edges. This class owns it once:
 *
 * - a run's terminal status is written once: the first of the run's own
 *   turn, a cancel, and a stale-row reconcile wins ({@link finish},
 *   {@link cancel}, {@link reconcileStale});
 * - a cancel is a no-op unless the run is open. It stops the run's own turn
 *   through the run's controller, and a turn chat recovery is re-running
 *   through the host ({@link cancel});
 * - the row names the request id of the turn that is streaming for the run,
 *   across a recovery too, so the turn's frames are attributed to the run
 *   ({@link bindTurn}, {@link rebind}, {@link intercept});
 * - what the row records for a turn's result is decided in one place
 *   ({@link agentToolRunOutcome}).
 *
 * The row itself (table name, columns) stays with the host, behind
 * {@link AgentToolRunStore}.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { AgentToolStoredChunk } from "../agent-tool-types";
import { interceptAgentToolBroadcast } from "./agent-tools";
import type { TurnQueue } from "./turn-queue";

/** What the core reads of a run row. */
export interface AgentToolRunRecord {
  runId: string;
  /** The request id of the turn bound to the run, if one was bound. */
  requestId: string | null;
  /**
   * The first request id bound to the run. A rebind replaces
   * {@link requestId} but never this one, and chat recovery keeps naming a
   * turn by it however many times the turn is recovered.
   */
  rootRequestId: string | null;
  /** `starting` and `running` are open; anything else is terminal. */
  status: string;
  /** A stream error recorded on the row, terminal or not. */
  error: string | null;
  /** The run was started with `eventDelivery: "terminal"`. */
  terminalOnly: boolean;
}

/** A terminal status and what is stored with it. */
export type AgentToolRunTerminal =
  | { status: "completed"; output: unknown; summary: string | null }
  | { status: "error"; error: string }
  | { status: "aborted"; error: string | null };

/** The host's run table. */
export interface AgentToolRunStore {
  /** The row of `runId`, or `null`. */
  read(runId: string): AgentToolRunRecord | null;
  /**
   * The open run that started last, or `null`. Must not create the table: a
   * host that never ran as an agent tool has none, and that reads as `null`.
   */
  newestOpen(): AgentToolRunRecord | null;
  /** The open run whose row names `requestId`, or `null`. */
  openForRequest(requestId: string): AgentToolRunRecord | null;
  /**
   * The run whose row names `requestId` as its current or its first request
   * id, open or not, or `null`.
   */
  forRequest(requestId: string): AgentToolRunRecord | null;
  /** The ids of every open run. Empty when there is no table. */
  listOpen(): string[];
  /** Insert the row of a new run, open. */
  insert(
    runId: string,
    run: { input: unknown; startedAt: number; terminalOnly: boolean }
  ): void;
  /**
   * Put the request id of the run's turn on its row. The first one bound
   * also becomes the run's root request id, which later binds leave alone.
   */
  bindRequest(runId: string, requestId: string): void;
  /** Record a stream error on a row that is still open. Must not throw. */
  recordStreamError(runId: string, error: string): void;
  /**
   * Write `terminal` to the row, only while the row is open.
   *
   * @param turnRequestId - The request id of the turn that produced it.
   * @returns Whether the row was written.
   */
  settle(
    runId: string,
    terminal: AgentToolRunTerminal,
    turnRequestId?: string
  ): boolean;
}

/** The result of the turn a run queued. */
export interface AgentToolTurnResult {
  requestId: string;
  status: "completed" | "error" | "aborted" | "skipped";
  error?: string;
}

/** What {@link AgentToolRuns} needs from the agent that hosts it. */
export interface AgentToolRunsHost {
  store: AgentToolRunStore;
  /** The turn queue. Its generation tells whether the chat was reset. */
  queue: TurnQueue;
  /** The host's use-chat-response wire type. */
  responseType: string;
  /** The error recorded for a run the chat was reset under. */
  resetError: string;
  /** Hold the isolate alive for the duration of `fn`. */
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** The output and summary of a run that produced an assistant reply. */
  collectResult(runId: string): { output: unknown; summary: string | null };
  /** Whether the run produced an assistant reply, with or without text. */
  hasAssistantReply(runId: string): boolean;
  /**
   * Stop the turn of a run that has no controller in this isolate: the run
   * was interrupted and chat recovery is re-running its turn, or is about
   * to. Cancel the requests the row names (current and root), their
   * scheduled recovery, and every recovery attempt that is running.
   */
  cancelRecoveredTurn(run: AgentToolRunRecord, reason: unknown): void;
  /** The state of chat recovery on this agent. */
  classifyRecovery(): Promise<"in-progress" | "failed" | "none">;
  /** `true` while a resumable stream is active. */
  hasActiveStream(): boolean;
  /** The run left memory: drop any per-run state the host keeps. */
  onForget?(runId: string): void;
}

const FAILED_ERROR = "Agent tool run failed during streaming.";
const INTERRUPTED_ERROR =
  "Agent tool run was interrupted before the child could finish.";

export function isAgentToolRunOpen(status: string): boolean {
  return status === "starting" || status === "running";
}

/**
 * What a run records for the result of its turn.
 *
 * - A turn the chat was reset under is an `error`, whether it was still in
 *   the queue (`skipped`) or already running (`aborted` by the reset): the
 *   parent did not cancel it.
 * - A turn that failed, or whose stream reported an error, is an `error`.
 * - A turn that was aborted otherwise is `aborted`.
 */
export function agentToolRunOutcome(input: {
  turn: Pick<AgentToolTurnResult, "status" | "error">;
  /** A stream error captured for the run, when the turn reported none. */
  streamError?: string;
  /** The chat was reset since the run started. */
  resetSinceStart: boolean;
  /** The error recorded for a reset. */
  resetError: string;
  /** Why the run's controller was aborted, if it was. */
  abortReason?: unknown;
}):
  | { status: "completed" }
  | Exclude<AgentToolRunTerminal, { output: unknown }> {
  const { turn } = input;
  const streamError = turn.error ?? input.streamError;
  if (
    turn.status === "skipped" ||
    (turn.status === "aborted" && input.resetSinceStart)
  ) {
    return { status: "error", error: streamError ?? input.resetError };
  }
  if (turn.status === "error" || streamError !== undefined) {
    return { status: "error", error: streamError ?? FAILED_ERROR };
  }
  if (turn.status === "aborted") {
    return { status: "aborted", error: reasonText(input.abortReason) };
  }
  return { status: "completed" };
}

function reasonText(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null;
  return reason instanceof Error ? reason.message : String(reason);
}

export class AgentToolRuns {
  /** Live tailers per run. */
  readonly forwarders = new Map<
    string,
    Set<(chunk: AgentToolStoredChunk) => void>
  >();
  /** Closers of the live tails per run. */
  readonly closers = new Map<string, Set<() => void>>();
  /**
   * One controller per run whose lifecycle ({@link start}) is running in
   * this isolate. A run with no entry was started by an earlier isolate.
   */
  readonly controllers = new Map<string, AbortController>();
  /** The last stream error captured per run. */
  readonly lastErrors = new Map<string, string>();
  /** The assistant message ids that existed before each run started. */
  readonly preTurnAssistantIds = new Map<string, Set<string>>();
  /** Per-run live counter of stored chunks. */
  readonly liveSequences = new Map<string, number>();
  /** Runs started with `eventDelivery: "terminal"`: their chunks are not broadcast. */
  readonly terminalOnlyRuns = new Set<string>();
  /**
   * Request id → run id for in-flight turns (`null` = resolved as not an
   * agent-tool turn, cached so unrelated turns do not query the store per
   * frame). A frame belongs to a run only when it carries the request id of
   * that run's turn (#1575).
   */
  readonly runsByRequestId = new Map<string, string | null>();

  constructor(private readonly host: AgentToolRunsHost) {}

  // ── Frames ─────────────────────────────────────────────────────────

  /**
   * Inspect an outgoing frame while any run is in flight: forward a run's
   * chunk to its tailers and capture its stream error.
   *
   * @returns `true` when the frame is a chunk of a terminal-only run, which
   *   the host must not broadcast.
   */
  intercept(msg: string | ArrayBuffer | ArrayBufferView): boolean {
    // Cheap idle guard so the common broadcast path stays allocation-free.
    if (
      this.forwarders.size === 0 &&
      this.liveSequences.size === 0 &&
      this.terminalOnlyRuns.size === 0
    ) {
      return false;
    }
    const chunkRunId = interceptAgentToolBroadcast(msg, {
      forwarders: this.forwarders,
      liveSequences: this.liveSequences,
      lastErrors: this.lastErrors,
      onError: (runId, body) => this.host.store.recordStreamError(runId, body),
      responseType: this.host.responseType,
      runForRequest: (requestId) => this.runForRequest(requestId),
      terminalOnlyRuns: this.terminalOnlyRuns
    });
    return chunkRunId !== null && this.terminalOnlyRuns.has(chunkRunId);
  }

  /**
   * The open run whose turn owns `requestId`, or `null`. Falls back to the
   * row, so attribution survives a restart mid-run; either answer is cached.
   */
  runForRequest(requestId: string): string | null {
    const cached = this.runsByRequestId.get(requestId);
    if (cached !== undefined) return cached;
    const run = this.host.store.openForRequest(requestId);
    if (run?.terminalOnly) this.terminalOnlyRuns.add(run.runId);
    const runId = run?.runId ?? null;
    this.runsByRequestId.set(requestId, runId);
    return runId;
  }

  /**
   * Bind the run to the request id of its turn, before the turn broadcasts a
   * frame: in memory for live attribution, and on the row so attribution
   * survives a restart mid-run (#1575).
   */
  bindTurn(runId: string, requestId: string): void {
    this.runsByRequestId.set(requestId, runId);
    this.host.store.bindRequest(runId, requestId);
  }

  /**
   * A recovered turn is about to start under `requestId`. When this agent
   * has an open run, the turn is that run's: put the new request id on the
   * row, so the parent keeps receiving the run's frames.
   *
   * Safe to call for every recovered turn. An agent that never ran as an
   * agent tool, or whose run has ended, has no open run.
   *
   * @param recoveredRequestId - The request id chat recovery names the
   *   turn by: the id it first ran under.
   * @returns `"cancelled"` when that turn belonged to a run that was
   *   cancelled before the turn could unwind, whether it was the run's first
   *   turn or an earlier recovery of it. The recovered turn must not run.
   */
  rebind(
    requestId: string,
    recoveredRequestId?: string
  ): "bound" | "cancelled" | "none" {
    const open = this.host.store.newestOpen();
    if (open) {
      if (open.terminalOnly) this.terminalOnlyRuns.add(open.runId);
      this.bindTurn(open.runId, requestId);
      return "bound";
    }
    if (recoveredRequestId !== undefined) {
      const run = this.host.store.forRequest(recoveredRequestId);
      if (run?.status === "aborted") return "cancelled";
    }
    return "none";
  }

  // ── The run's life ─────────────────────────────────────────────────

  /** `true` while the run's lifecycle is running in this isolate. */
  isLive(runId: string): boolean {
    return this.controllers.has(runId);
  }

  /**
   * `true` once the run's controller was aborted. The run's turn checks it
   * when it starts: a run cancelled while its turn waited in the queue
   * stores nothing and never calls the model.
   */
  isCancelled(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted ?? false;
  }

  /**
   * Start a run: insert its row, then run its turn in the background and
   * record the outcome. The caller has checked that no row exists.
   *
   * @param options.signal - The parent's signal. Aborting it aborts the run.
   * @param runTurn - Queue the run's turn and resolve with its result.
   *   `signal` aborts when the run is cancelled.
   * @returns When the run started.
   */
  start(
    runId: string,
    options: {
      input: unknown;
      terminalOnly: boolean;
      assistantIds: Set<string>;
      signal?: AbortSignal;
    },
    runTurn: (signal: AbortSignal) => Promise<AgentToolTurnResult>
  ): number {
    const startedAt = Date.now();
    this.host.store.insert(runId, {
      input: options.input,
      startedAt,
      terminalOnly: options.terminalOnly
    });
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.preTurnAssistantIds.set(runId, options.assistantIds);
    this.liveSequences.set(runId, 0);
    if (options.terminalOnly) this.terminalOnlyRuns.add(runId);

    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, {
        once: true
      });
    }

    const generation = this.host.queue.generation;
    const lifecycle = async () => {
      try {
        const turn = await runTurn(controller.signal);
        const outcome = agentToolRunOutcome({
          turn,
          streamError: this.lastErrors.get(runId),
          resetSinceStart: this.host.queue.generation !== generation,
          resetError: this.host.resetError,
          abortReason: controller.signal.reason
        });
        this.host.store.settle(
          runId,
          outcome.status === "completed"
            ? { status: "completed", ...this.host.collectResult(runId) }
            : outcome,
          turn.requestId
        );
      } catch (error) {
        // A turn that threw because the run was aborted is `aborted`.
        this.host.store.settle(
          runId,
          controller.signal.aborted
            ? {
                status: "aborted",
                error: reasonText(controller.signal.reason)
              }
            : {
                status: "error",
                error: error instanceof Error ? error.message : String(error)
              }
        );
      } finally {
        options.signal?.removeEventListener("abort", abortFromParent);
        this.controllers.delete(runId);
        this.host.onForget?.(runId);
        // Drop this run's request-id mappings. When no run remains in
        // flight clear the whole map, so negative entries for unrelated
        // turns cannot accumulate (#1575).
        if (this.controllers.size === 0) {
          this.runsByRequestId.clear();
        } else {
          for (const [requestId, owner] of this.runsByRequestId) {
            if (owner === runId) this.runsByRequestId.delete(requestId);
          }
        }
        this.closeTailers(runId);
      }
    };
    void this.host.keepAliveWhile(lifecycle);
    return startedAt;
  }

  /**
   * Cancel a run. A no-op for a run that does not exist or has ended, so a
   * late or repeated cancel aborts nothing.
   *
   * A run whose lifecycle is in this isolate is stopped through its own
   * controller, which reaches its turn whether the turn is queued or
   * running, and no other turn. A run with no controller here was
   * interrupted: the host stops whatever chat recovery is doing for it.
   * Either way the row records `aborted` now, and no later outcome replaces
   * it.
   */
  cancel(runId: string, reason?: unknown): void {
    const run = this.host.store.read(runId);
    if (!run || !isAgentToolRunOpen(run.status)) return;
    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort(reason);
    } else {
      this.host.cancelRecoveredTurn(run, reason);
    }
    this.host.store.settle(runId, {
      status: "aborted",
      error: reasonText(reason)
    });
    // Release any parent live-tail so it stops waiting on this run.
    this.closeTailers(runId);
  }

  /**
   * Close the run's live tails. For a run with no lifecycle in this isolate
   * also drop its streaming state, which nothing else would: a live run
   * keeps it until {@link start}'s lifecycle ends.
   */
  closeTailers(runId: string): void {
    const closers = this.closers.get(runId);
    if (closers) {
      for (const close of closers) close();
      this.closers.delete(runId);
    }
    this.forwarders.delete(runId);
    if (!this.controllers.has(runId)) {
      this.liveSequences.delete(runId);
      this.lastErrors.delete(runId);
      this.preTurnAssistantIds.delete(runId);
      this.terminalOnlyRuns.delete(runId);
    }
  }

  // ── A run an earlier isolate started ───────────────────────────────

  /** `true` for an open run with no lifecycle in this isolate. */
  isStale(run: AgentToolRunRecord): boolean {
    return isAgentToolRunOpen(run.status) && !this.controllers.has(run.runId);
  }

  /**
   * Settle a stale run from the agent's own chat recovery (#1630). Recovery
   * re-runs the interrupted turn but never writes the run row, so without
   * this the row stays open and the parent can only report `interrupted`.
   *
   * While recovery is still working (an active stream, or an incident in
   * progress) the row is left open, so the parent keeps waiting. The row is
   * read again after the wait and written only while it is still open: a
   * cancel that landed meanwhile stands.
   */
  async reconcileStale(runId: string): Promise<void> {
    const recovery = await this.host.classifyRecovery();
    if (recovery === "in-progress" || this.host.hasActiveStream()) return;
    const run = this.host.store.read(runId);
    if (!run || !this.isStale(run)) return;
    if (run.error !== null) {
      // A recorded stream error means the turn failed even if it stored a
      // reply, as in the live lifecycle.
      this.host.store.settle(runId, { status: "error", error: run.error });
    } else if (recovery !== "failed" && this.host.hasAssistantReply(runId)) {
      // A reply with no final text (it ended on a tool result) still
      // completed the run.
      this.host.store.settle(runId, {
        status: "completed",
        ...this.host.collectResult(runId)
      });
    } else {
      this.host.store.settle(runId, {
        status: "error",
        error: INTERRUPTED_ERROR
      });
    }
    this.closeTailers(runId);
  }

  /**
   * Settle this agent's own stale runs once a recovered turn has settled, so
   * a re-attached parent collects the terminal at once and does not wait out
   * a no-progress window (#1630). Best-effort: a parent inspect still
   * reconciles lazily.
   */
  async reconcileOwn(): Promise<void> {
    for (const runId of this.host.store.listOpen()) {
      if (this.controllers.has(runId)) continue;
      try {
        await this.reconcileStale(runId);
      } catch {
        // A parent inspect reconciles it.
      }
    }
  }
}
