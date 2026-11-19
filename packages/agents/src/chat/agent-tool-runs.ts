/**
 * AgentToolRuns — everything an agent does when a parent runs it as a tool,
 * shared by `@cloudflare/ai-chat` (`AIChatAgent`) and `@cloudflare/think`
 * (`Think`).
 *
 * A parent agent starts a run, follows the run's frames, and reads the
 * run's terminal status. Each host used to write all of that itself. This
 * class is the one owner:
 *
 * - the run row and its milestones ({@link AgentToolRunStore}, one SQL
 *   implementation, the hosts name the tables);
 * - the run's life: {@link start}, {@link cancel}, and the reconcile of a
 *   run an earlier isolate started ({@link reconcileStale});
 * - a run's terminal status is written once: the first of the run's own
 *   turn, a cancel, and a reconcile wins;
 * - a cancel is a no-op unless the run is open. It stops the run's own turn
 *   through the run's controller, and a turn chat recovery is re-running by
 *   the request ids on the run row, and nothing else. A cancel is recorded
 *   as one (`cancelledAt`): `aborted` alone does not mean a parent cancelled;
 * - a run whose turn was cut off while chat recovery works on it stays open
 *   and is settled when recovery ends, with or without an eviction;
 * - nothing here assumes the agent serves one run and nothing else. A run
 *   is tied to its turn by the request ids on its row, and only recovery of
 *   that turn binds to it, holds it open, or settles it;
 * - a run is open while its status is `starting` or `running`
 *   ({@link isAgentToolRunOpen}), and this class is the only place that
 *   decides whether a row may still be written;
 * - the row names the request id of the turn that is streaming for the run,
 *   across a recovery too, so the turn's frames are attributed to the run
 *   ({@link bindTurn}, {@link rebind}, {@link intercept});
 * - what the parent reads: {@link inspect}, {@link chunks}, {@link tail};
 * - progress and milestones ({@link reportProgress}).
 *
 * The host supplies what differs: how the run's turn is queued, what the
 * run's output and summary are, and how a frame is broadcast.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import {
  isPositionlessAgentToolChunk,
  type AgentToolProgress,
  type AgentToolRunInspection,
  type AgentToolStoredChunk
} from "../agent-tool-types";
import {
  AgentToolProgressEmitter,
  interceptAgentToolBroadcast,
  type AgentToolProgressEmitResult
} from "./agent-tools";
import type {
  AgentToolRunRecord,
  AgentToolRunStore,
  AgentToolRunTerminal
} from "./agent-tool-run-store";
import { CHAT_RECOVERY_CANCELLED_REASON } from "./recovery-engine";
import {
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  type ChatRecoveryIncident
} from "./recovery-incident";

/** The result of the turn a run queued. */
export interface AgentToolTurnResult {
  requestId: string;
  status: "completed" | "error" | "aborted" | "skipped";
  error?: string;
  /**
   * For `aborted`: `"interrupted"` when the reply was cut off and handed to
   * chat recovery, which may still finish it (`runServerTurn`).
   */
  reason?: "stopped" | "interrupted";
}

/** The parts of the host's resumable stream a run's chunks are read from. */
export interface AgentToolStreams {
  /** Write buffered chunks to storage, so a read sees them. */
  flushBuffer(): void;
  /** The newest stream a request wrote, or `null`. */
  latestStreamInfoForRequest(requestId: string): { id: string } | null;
  /** A stream's stored chunks, with their position. */
  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }>;
  /** The request whose stream is active, or `null`. */
  readonly activeRequestId: string | null;
}

/** What {@link AgentToolRuns} needs from the agent that hosts it. */
export interface AgentToolRunsHost {
  store: AgentToolRunStore;
  /** The host's resumable stream. Resolved on each use. */
  streams(): AgentToolStreams;
  /** Durable Object storage, where chat recovery keeps its incidents. */
  storage(): Pick<DurableObjectStorage, "list">;
  /** The host's use-chat-response wire type. */
  responseType: string;
  /** The error recorded for a run the chat was reset under. */
  resetError: string;
  /** Hold the isolate alive for the duration of `fn`. */
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** Mint the request id of a run's turn. */
  generateRequestId(): string;
  /** The request id of the turn the caller is running in, if any. */
  activeRequestId(): string | null | undefined;
  /** Broadcast one chunk of a request's reply to clients and tailers. */
  broadcastChunk(requestId: string, body: string): void;
  /**
   * The output and summary of a run that produced an assistant reply.
   *
   * @param input - The run's input: as it was passed when the run started
   *   in this isolate, its stored copy otherwise.
   */
  collectResult(
    runId: string,
    input: unknown
  ): { output: unknown; summary: string | null };
  /** The stored transcript, oldest first. */
  messages(): ReadonlyArray<{
    id: string;
    role: string;
    parts?: ReadonlyArray<unknown>;
  }>;
  /**
   * Cancel one request the way a client's stop does: its turn, queued or
   * running, a recovery attempt running for it, and a recovery scheduled
   * for it. Used for a run that has no controller in this isolate, whose
   * turn chat recovery is re-running or is about to.
   */
  cancelRequest(requestId: string, reason: unknown): void;
}

const FAILED_ERROR = "Agent tool run failed during streaming.";
const INTERRUPTED_ERROR =
  "Agent tool run was interrupted before the child could finish.";
const NEVER_STARTED_ERROR =
  "Agent tool run was interrupted while its turn was still waiting to start. Nothing of it was stored, so there was nothing to recover. Run it again.";

/**
 * The one definition of an open run: its status is `starting` or `running`.
 * The stores' selects filter on the same two statuses.
 */
export function isAgentToolRunOpen(status: string): boolean {
  return status === "starting" || status === "running";
}

/**
 * What a run records for the result of its turn.
 *
 * - A turn the chat was reset under is an `error`: the parent did not cancel
 *   it. The turn core reports such a turn `skipped`, whether it was still
 *   in the queue or already running (`mapServerTurnOutcome`).
 * - A turn that failed, or whose stream reported an error, is an `error`.
 * - A turn that was aborted otherwise is `aborted`: something other than
 *   the run's own cancel stopped it (a stop of its request, every request).
 *   A cancel of the run never gets here. {@link AgentToolRuns.cancel} writes
 *   the row itself, whatever the stream said.
 */
export function agentToolRunOutcome(input: {
  turn: Pick<AgentToolTurnResult, "status" | "error">;
  /** A stream error captured for the run, when the turn reported none. */
  streamError?: string;
  /** The error recorded for a reset. */
  resetError: string;
}):
  | { status: "completed" }
  | Exclude<AgentToolRunTerminal, { output: unknown }> {
  const { turn } = input;
  const streamError = turn.error ?? input.streamError;
  if (turn.status === "skipped") {
    return { status: "error", error: streamError ?? input.resetError };
  }
  if (turn.status === "error" || streamError !== undefined) {
    return { status: "error", error: streamError ?? FAILED_ERROR };
  }
  if (turn.status === "aborted") {
    return { status: "aborted", error: null };
  }
  return { status: "completed" };
}

/**
 * The message a run's own part of the transcript starts after: the newest
 * one, skipping assistant replies with no parts. The turn that follows
 * removes such an empty reply, and an anchor that is gone would make every
 * message look like the run's.
 */
function startAnchor(
  transcript: ReadonlyArray<{
    id: string;
    role: string;
    parts?: ReadonlyArray<unknown>;
  }>
): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message.role === "assistant" && message.parts?.length === 0) continue;
    return message.id;
  }
  return null;
}

/** An abort reason as text, or `null` when none was given. */
export function abortReasonText(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null;
  return reason instanceof Error ? reason.message : String(reason);
}

const chunkEncoder = new TextEncoder();

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
  /** The input of each run started in this isolate, as it was passed in. */
  readonly #liveInputs = new Map<string, unknown>();
  /** Removes the listener on the parent's signal, per run that has one. */
  readonly parentSignals = new Map<string, () => void>();
  readonly #progress: AgentToolProgressEmitter;

  constructor(private readonly host: AgentToolRunsHost) {
    this.#progress = new AgentToolProgressEmitter({
      resolveActiveRun: () => {
        // No active turn is no key in the map.
        const runId = this.runsByRequestId.get(
          host.activeRequestId() as string
        );
        const requestId = host.activeRequestId() as string;
        return runId ? { runId, requestId } : null;
      },
      broadcast: (requestId, body) => host.broadcastChunk(requestId, body),
      persistSnapshot: (runId, snapshot, at) =>
        host.store.writeProgress(runId, snapshot, at),
      persistMilestone: (runId, name, data, at) =>
        host.store.addMilestone(runId, name, data, at)
    });
  }

  /** The run table. */
  get store(): AgentToolRunStore {
    return this.host.store;
  }

  // ── Frames ─────────────────────────────────────────────────────────

  /**
   * Inspect an outgoing frame while any run is in flight: forward a run's
   * chunk to its tailers and capture its stream error.
   *
   * @returns `true` when the frame is a chunk of a terminal-only run, which
   *   the host must not broadcast.
   */
  intercept(msg: string | ArrayBuffer | ArrayBufferView): boolean {
    // With no run in flight this returns before it parses anything.
    const chunkRunId = interceptAgentToolBroadcast(msg, {
      forwarders: this.forwarders,
      liveSequences: this.liveSequences,
      lastErrors: this.lastErrors,
      onError: (runId, body) => this.#recordStreamError(runId, body),
      responseType: this.host.responseType,
      runForRequest: (requestId) => this.runForRequest(requestId),
      terminalOnlyRuns: this.terminalOnlyRuns
    });
    // `has(null)` is false: a frame that is no run's chunk is broadcast.
    return this.terminalOnlyRuns.has(chunkRunId as string);
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
  bindTurn(runId: string, requestId: string, rootRequestId?: string): void {
    this.runsByRequestId.set(requestId, runId);
    this.host.store.bindRequest(runId, requestId, rootRequestId);
  }

  // ── Progress ───────────────────────────────────────────────────────

  /**
   * Report progress or a milestone for the run whose turn the caller is
   * in. `"inactive"` when the caller is not inside a run's turn.
   */
  reportProgress(
    progress: AgentToolProgress,
    options?: { persist?: boolean }
  ): AgentToolProgressEmitResult {
    return this.#progress.report(progress, options);
  }

  /**
   * A recovered turn is about to start under `requestId`. When it is the
   * turn of an open run, put the new request id on the run's row, so the
   * parent keeps receiving the run's frames.
   *
   * Safe to call for every recovered turn. Only the run whose row names the
   * turn binds: another turn recovered on the same agent leaves it alone.
   *
   * @param rootRequestId - The request id recovery names the turn by: the
   *   id it first ran under. Without one the turn is not a recovery and
   *   nothing is bound.
   */
  rebind(requestId: string, rootRequestId: string | undefined): void {
    if (rootRequestId === undefined) return;
    const run = this.host.store.forRequest(rootRequestId);
    if (!run || !isAgentToolRunOpen(run.status)) return;
    if (run.terminalOnly) this.terminalOnlyRuns.add(run.runId);
    // A row written before rows had a root request id takes the one
    // recovery names the turn by, not the recovered turn's own id: the
    // next recovery, and a cancel, still find the run by it.
    this.bindTurn(run.runId, requestId, rootRequestId);
    // A turn that is being recovered did start.
    this.host.store.markTurnStarted(run.runId, Date.now());
  }

  /**
   * Whether the turn chat recovery is about to re-run belonged to a run its
   * parent cancelled. The cancel wrote the row, but the isolate died before
   * the aborted turn could unwind, so recovery woke for it. That turn must
   * not run. Recovery entry points check this right after their own
   * cancelled check and record the incident as cancelled.
   *
   * It reads the row's cancel marker, not its status. A run can be
   * `aborted` without a parent having cancelled it.
   *
   * @param rootRequestId - The request id recovery names the turn by: the
   *   id it first ran under, however often it was recovered since.
   */
  isRecoveredRunCancelled(rootRequestId: string | undefined): boolean {
    if (rootRequestId === undefined) return false;
    return this.host.store.forRequest(rootRequestId)?.cancelledAt != null;
  }

  /**
   * Whether a recovery attempt may run. Call it right after the attempt's
   * own cancelled check. An attempt for a turn whose run was cancelled
   * ({@link isRecoveredRunCancelled}) may not, and its incident is recorded
   * as cancelled, like a client's stop.
   *
   * @param attempt - The attempt's schedule payload.
   * @param updateIncident - The host's incident write.
   */
  async admitRecoveredTurn(
    attempt: { incidentId?: string; originalRequestId?: string } | undefined,
    updateIncident: (
      incidentId: string | undefined,
      status: "skipped",
      reason: string
    ) => Promise<void>
  ): Promise<boolean> {
    if (!attempt || !this.isRecoveredRunCancelled(attempt.originalRequestId)) {
      return true;
    }
    await updateIncident(
      attempt.incidentId,
      "skipped",
      CHAT_RECOVERY_CANCELLED_REASON
    );
    return false;
  }

  // ── The run's life ─────────────────────────────────────────────────

  /** `true` while the run's lifecycle is running in this isolate. */
  isLive(runId: string): boolean {
    return this.controllers.has(runId);
  }

  /**
   * Start a run: insert its row, then run its turn in the background and
   * record the outcome. Starting a run id that already has a row starts
   * nothing and reports that run.
   *
   * @param options.signal - The parent's signal. Aborting it aborts the run.
   * @param runTurn - Queue the run's turn and resolve with its result. The
   *   turn runs under `requestId`, which is already on the run's row, so
   *   its frames are attributed from the first one (#1575). `signal` aborts
   *   when the run is cancelled. `shouldStart` is asked when the turn
   *   reaches the front of the queue: a run cancelled while it waited
   *   stores nothing and never calls the model.
   */
  async start(
    runId: string,
    options: { input: unknown; terminalOnly: boolean; signal?: AbortSignal },
    runTurn: (turn: {
      requestId: string;
      signal: AbortSignal;
      shouldStart: () => boolean;
    }) => Promise<AgentToolTurnResult>
  ): Promise<AgentToolRunInspection> {
    // The check and the insert are one synchronous step: two starts of the
    // same run id, the second sent before the first returned, must not both
    // find no row.
    if (this.host.store.read(runId)) {
      // SAFETY: the row exists, so the inspection does.
      return (await this.inspect(runId)) as AgentToolRunInspection;
    }

    const startedAt = Date.now();
    this.host.store.insert(runId, {
      input: options.input,
      startedAt,
      terminalOnly: options.terminalOnly
    });
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.#noteTranscript(runId);
    this.liveSequences.set(runId, 0);
    this.#liveInputs.set(runId, options.input);
    if (options.terminalOnly) this.terminalOnlyRuns.add(runId);

    // The parent's signal is a cancel like any other: one path, so the row
    // records it at once and its reason, whatever the turn does afterwards.
    const parent = options.signal;
    if (parent) {
      const abortFromParent = () => this.cancel(runId, parent.reason);
      if (parent.aborted) {
        abortFromParent();
      } else {
        parent.addEventListener("abort", abortFromParent);
        // Kept until the run ends, not until its first turn does: a run
        // left open for recovery can still be cancelled through the signal.
        this.parentSignals.set(runId, () =>
          parent.removeEventListener("abort", abortFromParent)
        );
      }
    }

    const lifecycle = async () => {
      // Set when the run is left open for chat recovery to finish.
      let recovering = false;
      try {
        // Cancelled before it was queued: there is no turn to run.
        if (controller.signal.aborted) return;
        const requestId = this.host.generateRequestId();
        this.bindTurn(runId, requestId);
        const turn = await runTurn({
          requestId,
          signal: controller.signal,
          shouldStart: () => {
            if (controller.signal.aborted) return false;
            // The turn is at the front of the queue. What is in the
            // transcript now was there before the run: a turn that ran
            // while this one waited is not the run's.
            this.#noteTranscript(runId);
            this.host.store.markTurnStarted(
              runId,
              Date.now(),
              startAnchor(this.host.messages())
            );
            return true;
          }
        });
        if (
          turn.status === "aborted" &&
          turn.reason === "interrupted" &&
          // A cancel or a stop settled the row meanwhile: nothing is left
          // to wait for.
          this.#isOpen(runId)
        ) {
          // The reply was cut off in this isolate and chat recovery is
          // scheduled for it. The run is not over: leave the row open, as
          // an eviction would have, and let recovery settle it
          // (reconcileOwn).
          recovering = true;
          return;
        }
        const outcome = agentToolRunOutcome({
          turn,
          streamError: this.lastErrors.get(runId),
          resetError: this.host.resetError
        });
        this.#settle(
          runId,
          () =>
            outcome.status === "completed"
              ? { status: "completed", ...this.#collect(runId) }
              : outcome,
          turn.requestId
        );
      } catch (error) {
        // A cancelled run's row is settled already, and this write is a
        // no-op for it.
        this.#settle(runId, () => ({
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        }));
      } finally {
        this.controllers.delete(runId);
        // A run left for recovery keeps its tails, its counters and its
        // record of the transcript at start: the recovered turn's frames
        // still belong to it. closeTailers drops them when it ends.
        if (!recovering) this.closeTailers(runId);
      }
    };
    void this.host.keepAliveWhile(lifecycle);
    return { runId, status: "running", startedAt };
  }

  /**
   * Cancel a run. A no-op for a run that does not exist or has ended, so a
   * late or repeated cancel aborts nothing.
   *
   * A run whose lifecycle is in this isolate is stopped through its own
   * controller, which reaches its turn whether the turn is queued or
   * running, and no other turn. A run with no controller here was
   * interrupted, and chat recovery owns its turn: cancel the request ids
   * the row names, the current one (the recovered turn runs under it) and
   * the first one (recovery attempts are registered under it). Nothing else
   * on the agent is touched: an agent can serve a parent's run and its own
   * users at once. Either way the row records the cancel and `aborted` now,
   * whatever the run's stream said before or says after, and no later
   * outcome replaces it.
   */
  cancel(runId: string, reason?: unknown): void {
    const run = this.host.store.read(runId);
    if (!run || !isAgentToolRunOpen(run.status)) return;
    // The row first: stopping the turn below comes back here through the
    // host's stop path ({@link stopped}), and finds the run settled.
    this.host.store.markCancelled(runId, Date.now());
    this.#settle(runId, () => ({
      status: "aborted",
      error: abortReasonText(reason)
    }));
    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort(reason);
    } else {
      for (const requestId of new Set([run.requestId, run.rootRequestId])) {
        if (requestId) this.host.cancelRequest(requestId, reason);
      }
    }
    // Release any parent live-tail so it stops waiting on this run.
    this.closeTailers(runId);
  }

  /**
   * A stop landed on the agent for `requestId`, or for every request
   * (`null`): a client's cancel, `abortRequest`, a stop of everything. Call
   * it from every stop path (`ChatTurnsHost.stopped`).
   *
   * A stop of a run's turn is a cancel of the run. The stop aborts the turn
   * or its recovery attempt and cancels a recovery that was scheduled, so
   * nothing is left that would finish the run. Without this a run left open
   * for recovery stays `running`, its tails stay open and the parent waits
   * on it for good.
   */
  stopped(requestId: string | null, reason?: unknown): void {
    if (requestId === null) {
      for (const runId of this.host.store.listOpen()) {
        this.cancel(runId, reason);
      }
      return;
    }
    const run = this.host.store.forRequest(requestId);
    if (run && isAgentToolRunOpen(run.status)) this.cancel(run.runId, reason);
  }

  /** Remember which messages are in the transcript now, for a live run. */
  #noteTranscript(runId: string): void {
    // Every id that is there: only the assistant ones are ever asked for.
    this.preTurnAssistantIds.set(
      runId,
      new Set(this.host.messages().map((message) => message.id))
    );
  }

  #isOpen(runId: string): boolean {
    return this.host.store.listOpen().includes(runId);
  }

  /**
   * Close the run's live tails. For a run with no lifecycle in this isolate
   * also drop everything kept in memory for it, which nothing else would: a
   * live run keeps it until {@link start}'s lifecycle ends.
   */
  closeTailers(runId: string): void {
    // Each tail removes its own closer as it closes.
    for (const close of [...(this.closers.get(runId) ?? [])]) close();
    this.forwarders.delete(runId);
    if (this.controllers.has(runId)) return;
    this.parentSignals.get(runId)?.();
    this.parentSignals.delete(runId);
    this.liveSequences.delete(runId);
    this.lastErrors.delete(runId);
    this.preTurnAssistantIds.delete(runId);
    this.terminalOnlyRuns.delete(runId);
    this.#liveInputs.delete(runId);
    this.#progress.forget(runId);
    // Drop this run's request-id mappings. When no run remains in memory
    // clear the whole map, so negative entries for unrelated turns cannot
    // accumulate (#1575).
    // (Every run in flight has a counter: a live one, and one left open
    // for recovery.)
    if (this.liveSequences.size === 0) {
      this.runsByRequestId.clear();
    } else {
      for (const [requestId, owner] of this.runsByRequestId) {
        if (owner === runId) this.runsByRequestId.delete(requestId);
      }
    }
  }

  /**
   * The run's own part of the transcript: `messages` without what was there
   * before the run started.
   *
   * A run started in this isolate knows which assistant replies were there.
   * For a run an earlier isolate started, the row names the newest message
   * at its start and what follows it is the run's. A row with no such
   * record (an empty transcript at start, or a row from an older version)
   * counts every message.
   */
  messagesSinceStart<Message extends { id: string; role: string }>(
    runId: string,
    messages: ReadonlyArray<Message>
  ): Message[] {
    const before = this.preTurnAssistantIds.get(runId);
    if (before) {
      return messages.filter(
        (message) => message.role !== "assistant" || !before.has(message.id)
      );
    }
    const startMessageId = this.host.store.read(runId)?.startMessageId;
    // No anchor, or an anchor that is gone, gives -1: every message.
    const start = messages.findIndex((m) => m.id === startMessageId);
    return messages.slice(start + 1);
  }

  // ── A run an earlier isolate started ───────────────────────────────

  /** `true` for an open run with no lifecycle in this isolate. */
  isStale(run: AgentToolRunRecord): boolean {
    return isAgentToolRunOpen(run.status) && !this.controllers.has(run.runId);
  }

  /**
   * Settle a stale run from the chat recovery of its turn (#1630). Recovery
   * re-runs the interrupted turn but never writes the run row, so without
   * this the row stays open and the parent can only report `interrupted`.
   *
   * While recovery of the run's turn is still working (its stream is
   * active, or an incident for its request ids is in progress) the row is
   * left open, so the parent keeps waiting. Recovery of any other turn on
   * the agent does not hold it. The row is read again after the wait and
   * written only while it is still open: a cancel that landed meanwhile
   * stands.
   */
  async reconcileStale(runId: string): Promise<void> {
    const stale = this.host.store.read(runId);
    if (!stale || !this.isStale(stale)) return;
    // Incidents still being worked mean the turn may yet finish; a
    // completed recovery deletes its incident.
    const recovery = await this.#recoveryOf(stale);
    if (recovery === "in-progress") return;
    // Read again: a recovered turn may have been bound meanwhile. A cancel
    // that landed meanwhile settled the row, and the write below is a
    // no-op for it.
    const run = this.host.store.read(runId) ?? stale;
    const active = this.host.streams().activeRequestId;
    if (active !== null && active === run.requestId) return;
    const error = run.error;
    this.#settle(runId, () => {
      // Recovery of the turn was stopped. The stop is the outcome, whatever
      // the cut-off reply holds.
      if (recovery === "cancelled") return { status: "aborted", error: null };
      // The run's turn was still in the queue when the isolate went away.
      // It stored nothing, so nothing in the transcript is the run's,
      // whatever another turn has stored since. (A row with no root request
      // id is from before turns were marked as started.)
      if (run.rootRequestId !== null && run.turnStartedAt === null) {
        return { status: "error", error: NEVER_STARTED_ERROR };
      }
      // A recorded stream error means the turn failed even if it stored a
      // reply, as in the live lifecycle.
      if (error !== null) return { status: "error", error };
      // A reply with no final text (it ended on a tool result) still
      // completed the run.
      if (
        recovery !== "failed" &&
        this.messagesSinceStart(runId, this.host.messages()).some(
          (message) => message.role === "assistant"
        )
      ) {
        return { status: "completed", ...this.#collect(runId) };
      }
      return { status: "error", error: INTERRUPTED_ERROR };
    });
    this.closeTailers(runId);
  }

  // ── What the parent reads ──────────────────────────────────────────

  /**
   * The run as the parent sees it, or `null` when there is no such run.
   * A stale run is reconciled first, unless `reconcile` is `false`.
   */
  async inspect(
    runId: string,
    options?: { reconcile?: boolean }
  ): Promise<AgentToolRunInspection | null> {
    let run = this.host.store.read(runId);
    if (!run) return null;
    if (options?.reconcile !== false && this.isStale(run)) {
      await this.reconcileStale(runId);
      run = this.host.store.read(runId) ?? run;
    }
    const completed = run.status === "completed";
    const milestones = this.host.store.milestones(runId);
    return {
      runId,
      status: run.status as AgentToolRunInspection["status"],
      requestId: run.requestId ?? undefined,
      streamId: this.#streamId(run),
      // A row an older version completed may hold no output.
      output: completed
        ? (run.output ?? this.#collect(runId).output)
        : undefined,
      summary: completed ? (run.summary ?? "") : undefined,
      // An aborted run reports why it was cancelled.
      error:
        run.status === "error" || run.status === "aborted"
          ? (run.error ?? undefined)
          : undefined,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? undefined,
      ...(run.progress ? { progress: run.progress } : {}),
      ...(milestones.length > 0 ? { milestones } : {})
    };
  }

  /**
   * The run's stored chunks after `afterSequence`. A chunk's sequence is
   * its position in the stream, the same numbering the live counter
   * ({@link liveSequences}) uses, so a tail can switch from stored replay
   * to live forwarding without a gap or a repeat.
   */
  chunks(
    runId: string,
    options?: { afterSequence?: number }
  ): AgentToolStoredChunk[] {
    const streams = this.host.streams();
    streams.flushBuffer();
    const run = this.host.store.read(runId);
    const streamId = run ? this.#streamId(run) : undefined;
    if (!streamId) return [];
    const after = options?.afterSequence ?? -1;
    return streams
      .getStreamChunks(streamId)
      .filter((chunk) => chunk.chunk_index > after)
      .map((chunk) => ({ sequence: chunk.chunk_index, body: chunk.body }));
  }

  /**
   * Follow the run: its stored chunks after `afterSequence`, then its live
   * chunks, each once and in order, as newline-delimited JSON. The stream
   * closes when the run ends or `signal` aborts. A consumer that cancels
   * the stream only detaches: it does not cancel the run.
   *
   * @param read - The host's public `getAgentToolChunks` and
   *   `inspectAgentToolRun`, so a subclass that overrides either is
   *   honoured. The defaults are {@link chunks} and {@link inspect}.
   */
  tail(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal },
    read: {
      chunks?: (
        runId: string,
        options?: { afterSequence?: number }
      ) => Promise<AgentToolStoredChunk[]>;
      inspect?: (runId: string) => Promise<AgentToolRunInspection | null>;
    } = {}
  ): ReadableStream<Uint8Array> {
    const signal = options?.signal;
    // Outside `start`, so `cancel` (its sibling on the source) reaches them.
    let forward: ((chunk: AgentToolStoredChunk) => void) | undefined;
    // This tail's entry in `closers`. Dropped when the tail ends, however
    // it ends: a tail of a finished run is never closed through it.
    let registered: (() => void) | undefined;
    /** Remove `entry` from the run's set in `map`, and an emptied set. */
    const drop = <T>(map: Map<string, Set<T>>, entry: T | undefined) => {
      const set = map.get(runId);
      // SAFETY: deleting what is not there, `undefined` included, is a no-op.
      set?.delete(entry as T);
      // Another tail of the run keeps the set. An empty one goes, so the
      // broadcast idle guard goes cold again.
      if (set?.size === 0) map.delete(runId);
    };
    const forget = () => drop(this.closers, registered);
    const detach = () => drop(this.forwarders, forward);
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        // Set while the backlog is read. A close that lands then is left to
        // the inspection after the drain, which closes the tail of a run
        // that has ended, so the chunks stored so far still reach the
        // consumer.
        let draining = true;
        const close = () => {
          if (draining) return;
          detach();
          forget();
          try {
            controller.close();
          } catch {
            // Already closed: the consumer cancelled the reader first.
          }
        };
        // An external abort (a parent's bounded re-attach budget) stops the
        // wait without cancelling the run.
        const abort = () => {
          // The consumer gave up: nothing more is wanted, backlog included.
          draining = false;
          close();
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort);

        // Stored positions and live sequences share one numbering, so one
        // high-water mark dedupes the handoff: a chunk that is both in the
        // drained backlog and in the live buffer is emitted once. Progress
        // and milestone frames and chunks too large to store have no stored
        // position, so they bypass the mark and never move it.
        let lastEmitted = options?.afterSequence ?? -1;
        const emit = (chunk: AgentToolStoredChunk) => {
          if (!isPositionlessAgentToolChunk(chunk)) {
            if (chunk.sequence <= lastEmitted) return;
            lastEmitted = chunk.sequence;
          }
          try {
            controller.enqueue(
              chunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
            );
          } catch {
            // The stream no longer takes chunks: it was closed or cancelled
            // while the backlog was read, or the consumer went away. Drop
            // the tail and say nothing: a throw here would leave the
            // broadcast loop and starve the run's other tailers.
            detach();
            forget();
          }
        };

        // Live chunks are parked while the backlog drains, so they neither
        // race ahead of it nor get lost.
        const pending: AgentToolStoredChunk[] = [];
        forward = (chunk) => {
          if (draining) {
            pending.push(chunk);
            return;
          }
          emit(chunk);
        };

        try {
          // Register the forwarder before the backlog is read. A chunk
          // stored and broadcast during that read would otherwise be in
          // neither (#1589). Seed a cold live counter first, so such a
          // chunk continues the stored numbering.
          this.#seedLiveSequence(runId);
          const forwarders = this.forwarders.get(runId) ?? new Set();
          forwarders.add(forward);
          this.forwarders.set(runId, forwarders);
          const closers = this.closers.get(runId) ?? new Set();
          closers.add(close);
          this.closers.set(runId, closers);
          registered = close;

          const backlog = read.chunks
            ? await read.chunks(runId, options)
            : this.chunks(runId, options);
          for (const chunk of backlog) emit(chunk);
          // No await between the drain and this handoff, so no live chunk
          // slips past it.
          draining = false;
          for (const chunk of pending) emit(chunk);

          // Also closes the tail of a run that ended while the backlog was
          // read. Settling a run drops a counter seeded above.
          const inspection = await (read.inspect ?? ((id) => this.inspect(id)))(
            runId
          );
          if (!inspection || !isAgentToolRunOpen(inspection.status)) close();
        } catch (error) {
          detach();
          forget();
          try {
            controller.error(error);
          } catch {
            // The stream is already torn down.
          }
        }
      },
      cancel: () => {
        detach();
        forget();
      }
    });
  }

  /** The stream the run's chunks are in: recorded, or its turn's newest. */
  #streamId(run: AgentToolRunRecord): string | undefined {
    if (run.streamId) return run.streamId;
    if (!run.requestId) return undefined;
    return (
      this.host.streams().latestStreamInfoForRequest(run.requestId)?.id ??
      undefined
    );
  }

  /**
   * After a restart the live counter is cold while the stored backlog sits
   * at N, and a tail attaches without {@link start} having seeded it. An
   * unseeded counter numbers the recovered turn's chunks from 0 and the
   * tail's high-water mark drops them. Seeds only an open run with a bound
   * turn; a warm counter stands.
   */
  #seedLiveSequence(runId: string): void {
    if (this.liveSequences.has(runId)) return;
    const run = this.host.store.read(runId);
    if (!run?.requestId || !isAgentToolRunOpen(run.status)) return;
    this.liveSequences.set(runId, this.chunks(runId).length);
  }

  /**
   * The state of chat recovery for the run's turn: the incidents that name
   * one of the row's request ids, and no others.
   */
  async #recoveryOf(
    run: AgentToolRunRecord
  ): Promise<"in-progress" | "cancelled" | "failed" | undefined> {
    // A row that never bound a request has neither, and matches nothing.
    const ids = new Set([run.requestId, run.rootRequestId]);
    ids.delete(null);
    const incidents = await this.host.storage().list<ChatRecoveryIncident>({
      prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
    });
    let failed = false;
    let cancelled = false;
    for (const incident of incidents.values()) {
      const root = incident.recoveryRootRequestId;
      if (!ids.has(incident.requestId) && !(root && ids.has(root))) continue;
      if (
        incident.status === "detected" ||
        incident.status === "scheduled" ||
        incident.status === "attempting"
      ) {
        return "in-progress";
      }
      if (incident.status === "exhausted" || incident.status === "failed") {
        failed = true;
      }
      // Only a skipped incident carries this reason.
      if (incident.reason === CHAT_RECOVERY_CANCELLED_REASON) cancelled = true;
    }
    if (cancelled) return "cancelled";
    return failed ? "failed" : undefined;
  }

  // ── Writes ─────────────────────────────────────────────────────────

  /**
   * Write a terminal status, only while the run is open. This is the one
   * guard behind "a terminal status is written once": the read and the
   * write are synchronous SQL, so nothing runs between them.
   *
   * @param terminal - Built only when the row will be written.
   */
  #settle(
    runId: string,
    terminal: () => AgentToolRunTerminal,
    turnRequestId?: string
  ): void {
    const run = this.host.store.read(runId);
    if (!run || !isAgentToolRunOpen(run.status)) return;
    this.host.store.writeTerminal(
      runId,
      terminal(),
      turnRequestId
        ? {
            requestId: turnRequestId,
            streamId:
              this.host.streams().latestStreamInfoForRequest(turnRequestId)
                ?.id ?? null
          }
        : undefined
    );
  }

  #collect(runId: string): { output: unknown; summary: string | null } {
    const input = this.#liveInputs.has(runId)
      ? this.#liveInputs.get(runId)
      : // SAFETY: a run's row is never deleted.
        (this.host.store.read(runId) as AgentToolRunRecord).input;
    return this.host.collectResult(runId, input);
  }

  /**
   * Record a run's stream error on its open row, so a reconcile after an
   * eviction still sees the failure. Runs inside `broadcast`, which must
   * never throw: the in-memory capture remains if the write fails.
   */
  #recordStreamError(runId: string, error: string): void {
    try {
      const run = this.host.store.read(runId);
      if (!run || !isAgentToolRunOpen(run.status)) return;
      this.host.store.recordStreamError(runId, error);
    } catch (cause) {
      console.error(
        `[agent-tool] failed to record a stream error for run ${runId}`,
        cause
      );
    }
  }

  /**
   * Settle this agent's own stale runs once a recovered turn has settled, so
   * a re-attached parent collects the terminal at once and does not wait out
   * a no-progress window (#1630). Best-effort: a parent inspect still
   * reconciles lazily.
   */
  async reconcileOwn(): Promise<void> {
    // A run that is live here is not stale, and is left alone.
    for (const runId of this.host.store.listOpen()) {
      try {
        await this.reconcileStale(runId);
      } catch {
        // A parent inspect reconciles it.
      }
    }
  }
}
