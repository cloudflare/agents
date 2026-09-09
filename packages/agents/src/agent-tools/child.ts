import type { UIMessage } from "ai";
import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgress,
  AgentToolProgressSnapshot,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk
} from "../agent-tool-types";
import { AgentToolProgressEmitter } from "../chat/agent-tools";
import { classifyAgentToolChildRecovery } from "../chat/recovery-incident";
import { LifecycleCapability } from "../lifecycle/capability";
import {
  agentToolsChildHost,
  type AgentToolsChildHost,
  type ChildTurnOutcome
} from "./child-host";

const agentToolChunkEncoder = new TextEncoder();

const CHILD_SCHEMA_VERSION_KEY = "cf_agents:agent_tools_child_schema_version";
/** Version 1: the unified child tables, adopted from `@cloudflare/think`. */
const CURRENT_CHILD_SCHEMA_VERSION = 1;

/** Pre-capability `@cloudflare/ai-chat` tables, folded in on first start. */
const LEGACY_RUNS_TABLE = "cf_ai_chat_agent_tool_runs";
const LEGACY_MILESTONES_TABLE = "cf_ai_chat_agent_tool_milestones";

/**
 * Terminal-or-not status of a child run row. Narrower than
 * {@link import("../agent-tool-types").AgentToolRunStatus}: `interrupted` is a
 * PARENT-side seal (the parent gave up watching), never something a child
 * writes about itself.
 */
type ChildRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "aborted";

type ChildRunRow = {
  run_id: string;
  request_id: string | null;
  stream_id: string | null;
  status: ChildRunStatus;
  summary: string | null;
  input_json: string | null;
  output_json: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
  progress_json: string | null;
  last_signal_at: number | null;
};

/**
 * Default prose for the message a chat harness injects when a `detached:
 * { notify }` run finishes.
 *
 * Exported so `Think.formatDetachedCompletion` and
 * `AIChatAgent.formatDetachedCompletion` — protected hooks an integrator
 * overrides — share one default instead of two copies. Delivery of the
 * message stays harness policy; this only decides the words.
 *
 * @param run - The run being reported.
 * @param result - Its terminal outcome.
 * @returns The message text, always non-empty.
 */
export function defaultDetachedCompletionText(
  run: AgentToolRunInfo,
  result: AgentToolLifecycleResult
): string {
  const label = `Background task "${run.agentType}" (run ${run.runId})`;
  switch (result.status) {
    case "completed":
      return result.summary
        ? `${label} finished:\n\n${result.summary}`
        : `${label} finished successfully.`;
    case "error":
      return `${label} failed${result.error ? `: ${result.error}` : "."}`;
    case "aborted":
      return `${label} was cancelled.`;
    case "interrupted":
      return result.reason === "budget-exceeded"
        ? `${label} ran out of time before completing and was stopped.`
        : `${label} was interrupted before completing${result.error ? `: ${result.error}` : "."}`;
    default:
      return `${label} ended (${result.status}).`;
  }
}

/**
 * Default prose for the synthetic message a chat harness injects when a
 * `detached: { onMilestones }` milestone is reached. The shared default behind
 * both harnesses' `formatDetachedMilestone` hook.
 *
 * @param run - The run that reached the milestone.
 * @param milestone - The milestone, including any persisted payload.
 * @returns The message text, always non-empty.
 */
export function defaultDetachedMilestoneText(
  run: AgentToolRunInfo,
  milestone: AgentToolMilestone
): string {
  const label = `Background task "${run.agentType}" (run ${run.runId})`;
  const detail =
    milestone.data !== undefined
      ? `\n\n${JSON.stringify(milestone.data, null, 2)}`
      : "";
  return `${label} reached milestone "${milestone.name}".${detail}`;
}

/**
 * The CHILD half of agent tools, as a Lifecycle capability.
 *
 * A sub-agent Durable Object installs this to become dispatchable as an agent
 * tool: it owns the child's run rows, milestone rows, live chunk fan-out to a
 * tailing parent, and the post-eviction reconcile that seals a run whose
 * isolate died mid-flight. The methods a parent calls over RPC keep the exact
 * names and signatures of
 * {@link import("../agent-tool-types").AgentToolChildAdapter}, so a harness
 * exposes them with one-line facades.
 *
 * Everything chat-shaped — running the turn, formatting input, extracting
 * output, broadcasting frames — is supplied by an
 * {@link AgentToolsChildHost} bound with
 * {@link import("./child-host").setAgentToolsChildHost}. Detached NOTIFICATION
 * delivery (injecting a message back into the conversation) is deliberately
 * NOT here: that is harness policy.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class AgentToolsChild extends LifecycleCapability {
  /** Live tailers per run; each forwarded chunk fans out to all of them. */
  readonly #forwarders = new Map<
    string,
    Set<(chunk: AgentToolStoredChunk) => void>
  >();
  /** Per-run tail closers, invoked when a run reaches terminal. */
  readonly #closers = new Map<string, Set<() => void>>();
  /** Controllers for runs this isolate actually started. */
  readonly #abortControllers = new Map<string, AbortController>();
  /** Per-run last error frame body, replayed to a late-attaching tailer. */
  readonly #lastErrors = new Map<string, string>();
  /** Assistant message ids present before a run's turn started. */
  readonly #preTurnAssistantIds = new Map<string, Set<string>>();
  /**
   * Per-run forwarded-chunk counter; advanced even with no tailer attached.
   *
   * This is deliberately a SEPARATE counter from the resumable stream's stored
   * chunk_index — do NOT try to "simplify" it away by sequencing off the store
   * position. Not every forwarded frame is durably stored: progress/milestone
   * frames (`reportProgress`) ride the same chat-response wire type and are
   * tapped + forwarded here, but persist out-of-band (progress snapshot /
   * milestone rows), so they have no store position. Sourcing the sequence from
   * the store would give them a colliding position and the tail's high-water
   * dedupe (`emit`) would silently drop them, breaking live progress/milestone
   * delivery to the parent. This counter sequences stored AND non-stored frames
   * on one monotonic line; the tail realigns it to the stored high-water on each
   * (re)attach so a replay→live handoff stays gap/duplicate-free.
   */
  readonly #liveSequences = new Map<string, number>();
  /**
   * Request id → run id for in-flight turns (null = resolved as not an
   * agent-tool turn, cached so unrelated turns don't re-query SQLite per
   * frame). Drives frame attribution in {@link observeChunk}: a frame belongs
   * to a run iff it carries that run's turn request id, so an error in an
   * unrelated turn or a concurrent run can never leak into another run's
   * state (#1575).
   */
  readonly #runsByRequestId = new Map<string, string | null>();

  #progressEmitter: AgentToolProgressEmitter | null = null;

  constructor() {
    super("agent-tools-child");
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Create the child tables and fold in pre-capability `ai-chat` rows. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(CHILD_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_CHILD_SCHEMA_VERSION) return;

    this.#ensureTables();
    this.#adoptLegacyTables();
    await storage.put(CHILD_SCHEMA_VERSION_KEY, CURRENT_CHILD_SCHEMA_VERSION);
  }

  // ── Child adapter surface (what a parent calls over RPC) ─────────────────

  /**
   * Start (or re-report) one agent-tool run on this child.
   *
   * Idempotent on `runId`: a run row that already exists is reported as-is, so
   * a retried dispatch never starts a second turn. The turn itself runs
   * detached under `keepAliveWhile`; this resolves as soon as the run is
   * durably `starting`.
   *
   * @param input - The agent-tool input payload, persisted for later reconcile.
   * @param options - The parent-assigned run id and an optional cancel signal.
   * @returns The run's inspection snapshot.
   */
  async startAgentToolRun(
    input: unknown,
    options: { runId: string; signal?: AbortSignal }
  ): Promise<AgentToolRunInspection> {
    const { runId } = options;
    const existing = this.#readRun(runId);
    if (existing) return this.#inspectionFromRow(existing);

    const host = this.#host();
    const startedAt = Date.now();
    this.#sql`
      INSERT INTO cf_agent_tool_child_runs
        (run_id, status, input_json, started_at)
      VALUES (${runId}, 'starting', ${stringifyValue(input)}, ${startedAt})
    `;

    const controller = new AbortController();
    this.#abortControllers.set(runId, controller);
    this.#liveSequences.set(runId, 0);
    this.#preTurnAssistantIds.set(
      runId,
      new Set(
        host
          .messages()
          .filter((message) => message.role === "assistant")
          .map((message) => message.id)
      )
    );

    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, {
        once: true
      });
    }

    void host.keepAliveWhile(async () => {
      try {
        this.#sql`
          UPDATE cf_agent_tool_child_runs
          SET status = 'running'
          WHERE run_id = ${runId} AND status = 'starting'
        `;
        // Bind the run to its turn's request id BEFORE the turn starts — in
        // memory for live frame attribution in `observeChunk`, and on the run
        // row so attribution survives a DO restart mid-run (#1575). A harness
        // that mints its own request id re-binds through `rebindRequestId`.
        const requestId = crypto.randomUUID();
        this.#runsByRequestId.set(requestId, runId);
        this.#sql`
          UPDATE cf_agent_tool_child_runs
          SET request_id = ${requestId}
          WHERE run_id = ${runId}
        `;

        const outcome = await host.runTurn({
          runId,
          requestId,
          message: host.formatInput(input, { runId }),
          signal: controller.signal
        });

        this.#sealFromOutcome(runId, input, outcome);
      } catch (error) {
        this.#sql`
          UPDATE cf_agent_tool_child_runs
          SET status = 'error',
              error_message = ${error instanceof Error ? error.message : String(error)},
              completed_at = ${Date.now()}
          WHERE run_id = ${runId}
            AND completed_at IS NULL
        `;
      } finally {
        options.signal?.removeEventListener("abort", abortFromParent);
        this.#abortControllers.delete(runId);
        this.#forwarders.delete(runId);
        this.#liveSequences.delete(runId);
        // Drop the progress emitter's per-run coalescing state.
        this.#progressEmitter?.forget(runId);
        // Drop this run's request-id mappings. When no runs remain in flight
        // clear the whole map, so negatively-cached (null) entries for
        // unrelated turns can't accumulate for the DO's lifetime — the map is
        // only consulted while a run is active (#1575).
        if (this.#abortControllers.size === 0) {
          this.#runsByRequestId.clear();
        } else {
          for (const [reqId, mapped] of this.#runsByRequestId) {
            if (mapped === runId) this.#runsByRequestId.delete(reqId);
          }
        }
        this.#lastErrors.delete(runId);
        this.#preTurnAssistantIds.delete(runId);
        for (const close of this.#closers.get(runId) ?? []) close();
        this.#closers.delete(runId);
      }
    });

    return { runId, status: "running", startedAt };
  }

  /**
   * Cancel a run: stop the turn, seal the row `aborted`, release live tails.
   *
   * @param runId - The run to cancel.
   * @param reason - Optional cancellation reason, recorded on the row.
   */
  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    const row = this.#readRun(runId);
    if (!row || row.completed_at !== null) return;
    // Stop the original in-isolate run if it's still live...
    this.#abortControllers.get(runId)?.abort(reason);
    // ...and any in-flight chat-recovery turn driving this child facet after an
    // eviction. A recovered turn re-runs outside `startAgentToolRun`, so it has
    // no entry in `#abortControllers`; a child facet is dedicated to a single
    // agent-tool run, so tearing down its active turns stops the recovery
    // instead of letting it keep grinding (and holding a keep-alive) after the
    // parent gave up on it and sealed `interrupted` (#1630 follow-up).
    this.#hostOrUndefined()?.abortRun(runId, reason);
    this.#sql`
      UPDATE cf_agent_tool_child_runs
      SET status = 'aborted',
          error_message = ${reason instanceof Error ? reason.message : reason === undefined ? null : String(reason)},
          completed_at = ${Date.now()}
      WHERE run_id = ${runId}
        AND status NOT IN ('completed', 'error', 'aborted')
    `;
    // Release any parent live-tail so it stops waiting on this run immediately.
    this.#finalizeTailers(runId);
  }

  /**
   * Report a run's current state, reconciling a stale row first.
   *
   * @param runId - The run to inspect.
   * @returns The inspection snapshot, or null when this child has no such run.
   */
  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    let row = this.#readRun(runId);
    if (!row) return null;
    // A `running`/`starting` row with no live abort controller means the
    // original in-isolate run is gone (e.g. the parent was evicted while this
    // child run was in flight, #1630) — lazily reconcile it from the child's
    // own durable recovery before reporting.
    if (this.#isStale(row)) {
      await this.#reconcileStaleRun(runId);
      row = this.#readRun(runId) ?? row;
    }
    const input = parseValue(row.input_json);
    return this.#inspectionFromRow(
      row,
      this.#hostOrUndefined()?.output(
        runId,
        this.#messagesAfterStart(runId),
        input
      )
    );
  }

  /**
   * Replay a run's durably stored stream chunks.
   *
   * @param runId - The run whose chunks to read.
   * @param options - `afterSequence` skips everything already delivered.
   * @returns Stored chunks in sequence order; empty when nothing streamed yet.
   */
  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    const host = this.#hostOrUndefined();
    if (!host) return [];
    const row = this.#readRun(runId);
    const streamId =
      row?.stream_id ??
      (row?.request_id ? host.streamIdForRequest(row.request_id) : undefined);
    if (!streamId) return [];
    host.flushChunks();
    return host.readChunks(streamId, options?.afterSequence);
  }

  /**
   * Follow a run: replay its stored backlog, then stream live chunks until it
   * reaches terminal (or the caller detaches).
   *
   * Chunks cross the RPC boundary as newline-delimited JSON bytes; the parent
   * decodes them back into {@link AgentToolStoredChunk} records.
   *
   * @param runId - The run to follow.
   * @param options - `afterSequence` to resume, `signal` to stop waiting.
   * @returns A stream that closes when the run settles or the caller detaches.
   */
  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    const signal = options?.signal;
    let closed = false;
    let forward: ((chunk: AgentToolStoredChunk) => void) | undefined;
    const detach = () => {
      if (forward) {
        const set = this.#forwarders.get(runId);
        set?.delete(forward);
        // Drop the now-empty set so the tap's idle-guard
        // (`#forwarders.size`) goes cold again. Otherwise a run that was
        // already terminal at attach — its `#finalizeTailers` already ran and
        // won't run again — leaves an empty set keyed by runId, and every
        // subsequent frame on this DO keeps paying the tap cost forever.
        if (set && set.size === 0) this.#forwarders.delete(runId);
        forward = undefined;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const close = () => {
          if (closed) return;
          closed = true;
          detach();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        // Honor an external abort (e.g. a bounded re-attach budget) so a parent
        // tailing a still-running child can stop waiting without cancelling the
        // child itself — closing the stream unblocks the parent's forwarder.
        if (signal?.aborted) {
          close();
          return;
        }
        signal?.addEventListener("abort", close, { once: true });

        // Stored chunk_index and the live forwarder sequence share one
        // monotonic numbering (see `getAgentToolChunks` + `observeChunk`), so a
        // single high-water mark dedupes the stored-replay → live-forwarding
        // handoff: a chunk that lands in both the drained backlog AND the live
        // buffer (stored + broadcast during the drain) is emitted exactly once,
        // in order.
        let lastEmitted = options?.afterSequence ?? -1;
        const emit = (chunk: AgentToolStoredChunk) => {
          if (closed || chunk.sequence <= lastEmitted) return;
          lastEmitted = chunk.sequence;
          try {
            controller.enqueue(
              agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
            );
          } catch {
            // The consumer detached (e.g. a parent's re-attach budget expired
            // and cancelled the reader) between the RPC cancel arriving and our
            // `cancel`/`close` running. Drop the chunk instead of surfacing a
            // "Stream was cancelled" rejection — and never call `close()` here,
            // which would throw out of the tap's forward loop and starve this
            // run's sibling tailers. The child run is unaffected.
            closed = true;
            detach();
          }
        };

        // While draining the stored backlog, park live chunks rather than
        // emitting them directly, so ordering/dedupe against the backlog is
        // resolved by `emit` while the forwarder (registered FIRST, below)
        // already catches everything the child produces.
        let draining = true;
        const pending: AgentToolStoredChunk[] = [];
        forward = (chunk: AgentToolStoredChunk) => {
          if (closed) return;
          if (draining) {
            pending.push(chunk);
            return;
          }
          emit(chunk);
        };

        // Register the live forwarder BEFORE draining the stored backlog.
        // Previously it was attached only AFTER `getAgentToolChunks` resolved;
        // any chunk the child stored AND broadcast during that `await` advanced
        // the live sequence with no forwarder attached, so it was neither in the
        // drained snapshot nor live-forwarded — silently dropped from the
        // parent's forward stream. A network-paced proxied child stream (a sub-
        // agent returning a remote `toUIMessageStreamResponse()`) hits this
        // window constantly, leaving tool parts stuck at `input-available`
        // (#1589).
        const forwarders = this.#forwarders.get(runId) ?? new Set();
        forwarders.add(forward);
        this.#forwarders.set(runId, forwarders);
        const closers = this.#closers.get(runId) ?? new Set<() => void>();
        closers.add(close);
        this.#closers.set(runId, closers);

        try {
          for (const chunk of await this.getAgentToolChunks(runId, options)) {
            if (closed) return;
            emit(chunk);
          }

          // Flush chunks that arrived live during the drain, then switch the
          // forwarder to direct emit. No `await` between here and the drain loop
          // means no live chunk can slip past this handoff.
          draining = false;
          for (const chunk of pending) emit(chunk);
          pending.length = 0;

          const row = this.#readRun(runId);
          if (!row || row.completed_at !== null) {
            close();
            return;
          }

          // Run is still live: realign the live sequence to continue right after
          // the highest emitted chunk (which now includes any captured during the
          // drain). Realigning to `lastEmitted + 1` rather than the backlog's last
          // sequence keeps a post-restart re-attach — where the in-memory counter
          // is cold while the stored backlog sits at N, and a chat-recovery
          // resume re-attaches WITHOUT re-running `startAgentToolRun` (which is
          // what seeds the counter) — from handing the recovered turn's chunks
          // sequences that `emit`'s high-water dedupe would silently drop. Gating
          // on the terminal check above also avoids repopulating `#liveSequences`
          // for an already-terminal run, which would re-heat the tap idle-guard
          // for the DO's lifetime.
          if (lastEmitted > (options?.afterSequence ?? -1)) {
            this.#liveSequences.set(runId, lastEmitted + 1);
          }
        } catch (error) {
          // A drain/read failure must surface to the consumer; detach first so
          // the forwarder we registered up front doesn't linger on this run.
          closed = true;
          detach();
          try {
            controller.error(error);
          } catch {
            // Stream already torn down.
          }
        }
      },
      cancel: () => {
        // A consumer detaching from the tail (e.g. a parent's bounded re-attach
        // budget expiring, via reader.cancel()) is read-only — it must NOT
        // cancel the child run. Explicit cancellation flows through
        // `cancelAgentToolRun`.
        closed = true;
        detach();
      }
    });

    // SAFETY: chunks cross the RPC boundary as encoded bytes (a
    // `ReadableStream<Uint8Array>` is what workerd can serialize); the declared
    // element type describes what the parent reconstitutes after decoding.
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  // ── Child-local surface (what the harness calls on itself) ───────────────

  /**
   * Emit a progress signal for the run executing in the current turn.
   *
   * Ephemeral progress rides the child's stream as a transient part and
   * persists only as a latest-wins snapshot; naming a `milestone` promotes the
   * signal to a durable, replayable row. Coalescing, wire framing, and
   * persistence are the shared {@link AgentToolProgressEmitter}'s.
   *
   * @param progress - The signal to emit.
   * @param options - `persist: true` retains `data` on the snapshot.
   */
  async reportProgress<T = unknown>(
    progress: AgentToolProgress<T>,
    options?: { persist?: boolean }
  ): Promise<void> {
    const result = this.#emitter().report(progress, options);
    if (result === "inactive") {
      console.warn(
        "[agent-tools] reportProgress() was called outside of an active agent-tool run; ignoring. Call it from within a turn that is running as a sub-agent."
      );
    }
  }

  /**
   * Tap one outgoing chat-response frame body for the run that owns its turn.
   *
   * The harness calls this from its stream pump for every chat-response frame
   * it broadcasts, INCLUDING the progress/milestone frames this capability
   * itself emits — that is what keeps stored and non-stored frames on one
   * monotonic sequence (see {@link AgentToolsChild.tailAgentToolRun}). A frame
   * belongs to a run iff it carries that run's turn request id, so concurrent
   * runs cannot cross-contaminate each other's progress.
   *
   * @param requestId - The frame's turn request id.
   * @param body - The frame body; empty bodies are ignored.
   */
  observeChunk(requestId: string, body: string): void {
    // Cheap idle guard so the common (no agent-tool run) pump stays
    // allocation-free. Live sequences exist for a run's whole lifecycle, so
    // this is cold only when no run is in flight.
    if (this.#forwarders.size === 0 && this.#liveSequences.size === 0) return;
    if (body.length === 0) return;
    const runId = this.#runForRequest(requestId);
    if (runId === null) return;
    // Advance the live sequence even with no tailer attached so a tailer
    // registering mid-run resumes at the right offset.
    const sequence = this.#liveSequences.get(runId) ?? 0;
    this.#liveSequences.set(runId, sequence + 1);
    const chunk: AgentToolStoredChunk = { sequence, body };
    const forwarders = this.#forwarders.get(runId);
    if (forwarders) {
      for (const forward of forwarders) forward(chunk);
    }
  }

  /**
   * Tap an error chat-response frame for the run that owns its turn, so the
   * failure is recorded even when no tailer is attached and can be replayed to
   * one that attaches late.
   *
   * @param requestId - The frame's turn request id.
   * @param body - The error text carried by the frame.
   */
  observeError(requestId: string, body: string): void {
    if (this.#forwarders.size === 0 && this.#liveSequences.size === 0) return;
    const runId = this.#runForRequest(requestId);
    if (runId === null) return;
    this.#lastErrors.set(runId, body);
  }

  /**
   * Re-bind this facet's in-flight child run to a NEW turn request id.
   *
   * When this facet is itself running as an agent-tool child and its turn is
   * interrupted (e.g. a deploy evicts it mid-run), the recovery continuation
   * mints a NEW request id. The run row's `request_id` — and the in-memory
   * attribution map — still point at the pre-eviction turn, so the tap can no
   * longer attribute the recovered turn's frames to the run. The parent's
   * re-attach tail then sees no forwarded chunks, its no-progress budget
   * elapses, and it abandons a healthy, still-advancing child as `interrupted`.
   * Re-binding keeps frame attribution alive across recovery so the parent
   * follows the child to its real terminal.
   *
   * Safe to call on EVERY recovery continuation, and on every turn a harness
   * that mints its own request ids starts:
   *   - a facet that never ran as an agent-tool child has no rows → no-op;
   *   - a facet whose run already settled has no active row → no-op;
   *   - a child DO is addressed by its `runId`, so it owns AT MOST ONE run row
   *     for its whole lifetime and is never reused as a top-level chat agent —
   *     the single active row is unambiguously this recovery's run. The
   *     `ORDER BY started_at DESC LIMIT 1` is defensive belt-and-suspenders.
   *
   * @param requestId - The current turn's request id.
   * @param runId - The run to bind, when the caller already knows it.
   */
  rebindRequestId(requestId: string, runId?: string): void {
    let target = runId;
    if (target === undefined) {
      const rows = this.#sql<{ run_id: string }>`
        SELECT run_id FROM cf_agent_tool_child_runs
        WHERE status IN ('starting', 'running')
        ORDER BY started_at DESC
        LIMIT 1
      `;
      target = rows[0]?.run_id;
    }
    if (!target) return;
    this.#runsByRequestId.set(requestId, target);
    this.#sql`
      UPDATE cf_agent_tool_child_runs
      SET request_id = ${requestId}
      WHERE run_id = ${target}
    `;
  }

  /**
   * Eagerly terminalize this facet's OWN run rows once a recovered turn has
   * settled.
   *
   * A recovered turn re-runs outside `startAgentToolRun`'s finalizer, so
   * without this the row strands `running` and its tailers stay open until a
   * parent inspect lazily reconciles it — forcing a re-attached parent to wait
   * out a full no-progress window before collecting an already-finished result
   * (#1630 follow-up). Reconciling here closes the tail promptly. No-op on
   * facets that never ran as a child, and on rows whose in-memory run is still
   * live (those are finalized by `startAgentToolRun`); the underlying reconcile
   * leaves a row `running` while its recovery is still in progress.
   */
  async reconcileStaleRuns(): Promise<void> {
    let rows: Array<{ run_id: string }>;
    try {
      rows = this.#sql<{ run_id: string }>`
        SELECT run_id FROM cf_agent_tool_child_runs
        WHERE completed_at IS NULL
      `;
    } catch {
      // No run table on this facet (it never ran as a child) — nothing to do.
      return;
    }
    for (const { run_id } of rows) {
      if (this.#abortControllers.has(run_id)) continue;
      try {
        await this.#reconcileStaleRun(run_id);
      } catch {
        // Best-effort: a parent inspect still reconciles lazily.
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #host(): AgentToolsChildHost {
    const host = agentToolsChildHost(this);
    if (!host) {
      throw new Error(
        "AgentToolsChild requires a host bound with setAgentToolsChildHost() before a run can start"
      );
    }
    return host;
  }

  #hostOrUndefined(): AgentToolsChildHost | undefined {
    return agentToolsChildHost(this);
  }

  #emitter(): AgentToolProgressEmitter {
    if (!this.#progressEmitter) {
      this.#progressEmitter = new AgentToolProgressEmitter({
        resolveActiveRun: () => {
          const requestId = this.#hostOrUndefined()?.activeRequestId();
          if (!requestId) return null;
          const runId = this.#runsByRequestId.get(requestId);
          return runId ? { runId, requestId } : null;
        },
        broadcast: (requestId, chunkBody) => {
          this.#hostOrUndefined()?.broadcastChunk(requestId, chunkBody);
        },
        persistSnapshot: (runId, snapshot, at) => {
          this.#sql`
            UPDATE cf_agent_tool_child_runs
            SET progress_json = ${JSON.stringify(snapshot)},
                last_signal_at = ${at}
            WHERE run_id = ${runId}
          `;
        },
        persistMilestone: (runId, name, data, at) =>
          this.#persistMilestone(runId, name, data, at)
      });
    }
    return this.#progressEmitter;
  }

  /**
   * Resolve the run whose turn owns a request id, or null when the request is
   * not an agent-tool turn. Falls back to the persisted row (whose
   * `request_id` is written when the run's turn is bound) so attribution
   * survives a DO restart mid-run; either outcome is cached.
   */
  #runForRequest(requestId: string): string | null {
    const cached = this.#runsByRequestId.get(requestId);
    if (cached !== undefined) return cached;
    // Active-run predicate: a child run is in flight while `status` is
    // `starting`/`running`; terminal rows set `status` AND `completed_at`
    // together (the lifecycle invariant), so this is equivalent to
    // `completed_at IS NULL` but states the intent.
    const rows = this.#sql<{ run_id: string }>`
      SELECT run_id FROM cf_agent_tool_child_runs
      WHERE request_id = ${requestId} AND status IN ('starting', 'running')
      LIMIT 1
    `;
    const runId = rows[0]?.run_id ?? null;
    this.#runsByRequestId.set(requestId, runId);
    return runId;
  }

  /**
   * Write a run's terminal from its turn outcome in ONE update guarded by
   * `completed_at IS NULL`, so a cancel that already sealed the row wins.
   */
  #sealFromOutcome(
    runId: string,
    input: unknown,
    outcome: ChildTurnOutcome
  ): void {
    const host = this.#host();
    const messagesAfterStart = this.#messagesAfterStart(runId);
    const output = host.output(runId, messagesAfterStart, input);
    const summary = host.summary(runId, output, messagesAfterStart, input);
    const streamError = outcome.error ?? this.#lastErrors.get(runId);
    const status: ChildRunStatus =
      outcome.status === "error" || outcome.status === "skipped" || streamError
        ? "error"
        : outcome.status === "aborted"
          ? "aborted"
          : "completed";
    // `skipped` is not an `AgentToolRunStatus`, so a turn that never ran is
    // sealed as `error` with prose that says so rather than being reported to
    // the parent as an empty success.
    const error: string | null =
      status === "error"
        ? (streamError ??
          "Agent tool run was skipped before the child could finish.")
        : null;
    this.#sql`
      UPDATE cf_agent_tool_child_runs
      SET request_id = ${outcome.requestId},
          stream_id = ${host.streamIdForRequest(outcome.requestId) ?? null},
          status = ${status},
          summary = ${summary},
          output_json = ${stringifyValue(output)},
          error_message = ${error},
          completed_at = ${Date.now()}
      WHERE run_id = ${runId}
        AND completed_at IS NULL
    `;
  }

  #isStale(row: ChildRunRow): boolean {
    return (
      (row.status === "running" || row.status === "starting") &&
      row.completed_at === null &&
      !this.#abortControllers.has(row.run_id)
    );
  }

  /**
   * Reconcile a stale (post-eviction) run row from the child's own durable
   * recovery (#1630). The child facet self-heals its interrupted turn via chat
   * recovery, but that path never writes the run row, so without this the row
   * strands `running` and the parent can only collect `interrupted`.
   *
   * Persisting the terminal here (rather than only computing it) is
   * intentional: it's a lazy materialization of the run's true terminal that
   * also lets a tailing parent's stream close promptly and makes subsequent
   * inspects cheap. While recovery is still resolving (active stream or
   * in-progress incident) the row is left `running` so the parent's bounded
   * re-attach keeps waiting.
   */
  async #reconcileStaleRun(runId: string): Promise<void> {
    const host = this.#hostOrUndefined();
    const recovery = await classifyAgentToolChildRecovery(
      this.lifecycle.storage
    );
    if (recovery === "in-progress" || host?.hasActiveStream()) return;

    const messagesAfterStart = this.#messagesAfterStart(runId);
    // A settled recovery that produced an assistant turn is `completed`, even
    // if that turn ended on a tool result with no final text — keying off text
    // alone would mis-seal a legitimately-finished (but text-less) run as
    // `error`. The host's `summary` already falls back when there is no text.
    const recoveredTurn =
      recovery !== "failed" &&
      messagesAfterStart.some((message) => message.role === "assistant");
    if (recoveredTurn && host) {
      const row = this.#readRun(runId);
      const input = parseValue(row?.input_json ?? null);
      const output = host.output(runId, messagesAfterStart, input);
      const summary = host.summary(runId, output, messagesAfterStart, input);
      this.#sql`
        UPDATE cf_agent_tool_child_runs
        SET status = 'completed',
            summary = ${summary},
            output_json = ${stringifyValue(output)},
            error_message = null,
            completed_at = ${Date.now()}
        WHERE run_id = ${runId} AND completed_at IS NULL
      `;
    } else {
      const error =
        "Agent tool run was interrupted before the child could finish.";
      this.#sql`
        UPDATE cf_agent_tool_child_runs
        SET status = 'error',
            error_message = ${error},
            completed_at = ${Date.now()}
        WHERE run_id = ${runId} AND completed_at IS NULL
      `;
    }
    this.#finalizeTailers(runId);
  }

  /** Release a run's live tails + per-run streaming bookkeeping. */
  #finalizeTailers(runId: string): void {
    for (const close of this.#closers.get(runId) ?? []) close();
    this.#closers.delete(runId);
    this.#forwarders.delete(runId);
    this.#liveSequences.delete(runId);
    this.#lastErrors.delete(runId);
    this.#preTurnAssistantIds.delete(runId);
  }

  /**
   * Messages the run's turn produced. A dedicated child facet starts with no
   * assistant messages, so a missing pre-turn snapshot — the in-memory one
   * died with the original isolate after a real eviction (#1630) — is treated
   * as empty and the recovered transcript still counts.
   */
  #messagesAfterStart(runId: string): readonly UIMessage[] {
    const before = this.#preTurnAssistantIds.get(runId) ?? new Set<string>();
    return (this.#hostOrUndefined()?.messages() ?? []).filter(
      (message) => message.role !== "assistant" || !before.has(message.id)
    );
  }

  #persistMilestone(
    runId: string,
    name: string,
    data: unknown,
    at: number
  ): number {
    const rows = this.#sql<{ next: number }>`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS next
      FROM cf_agent_tool_milestones WHERE run_id = ${runId}
    `;
    const sequence = rows[0]?.next ?? 0;
    this.#sql`
      INSERT OR IGNORE INTO cf_agent_tool_milestones
        (run_id, sequence, name, data_json, at)
      VALUES (
        ${runId}, ${sequence}, ${name},
        ${data !== undefined ? JSON.stringify(data) : null}, ${at}
      )
    `;
    // A milestone is a progress signal too: advance the no-progress clock.
    this.#sql`
      UPDATE cf_agent_tool_child_runs SET last_signal_at = ${at}
      WHERE run_id = ${runId}
    `;
    return sequence;
  }

  #readMilestones(runId: string): AgentToolMilestone[] {
    return this.#sql<{
      sequence: number;
      name: string;
      data_json: string | null;
      at: number;
    }>`
      SELECT sequence, name, data_json, at FROM cf_agent_tool_milestones
      WHERE run_id = ${runId} ORDER BY sequence ASC
    `.map((row) => ({
      name: row.name,
      sequence: row.sequence,
      at: row.at,
      ...(row.data_json != null ? { data: parseValue(row.data_json) } : {})
    }));
  }

  #readRun(runId: string): ChildRunRow | null {
    const rows = this.#sql<ChildRunRow>`
      SELECT run_id, request_id, stream_id, status, summary, input_json,
             output_json, error_message, started_at, completed_at,
             progress_json, last_signal_at
      FROM cf_agent_tool_child_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  #inspectionFromRow(
    row: ChildRunRow,
    output?: unknown
  ): AgentToolRunInspection {
    const milestones = this.#readMilestones(row.run_id);
    const progress = progressSnapshotFromRow(row);
    return {
      runId: row.run_id,
      status: row.status,
      requestId: row.request_id ?? undefined,
      streamId: row.stream_id ?? undefined,
      output: row.output_json === null ? output : parseValue(row.output_json),
      summary: row.summary ?? undefined,
      error: row.error_message ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      ...(progress ? { progress } : {}),
      ...(milestones.length > 0 ? { milestones } : {})
    };
  }

  #ensureTables(): void {
    const sql = this.lifecycle.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agent_tool_child_runs (
        run_id TEXT PRIMARY KEY,
        request_id TEXT,
        stream_id TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        input_json TEXT,
        output_json TEXT,
        error_message TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        progress_json TEXT,
        last_signal_at INTEGER
      )
    `);
    // Existing `@cloudflare/think` deployments already carry the table from
    // before this capability owned it, without the columns added since. A
    // duplicate-column failure means the column is already there.
    for (const column of [
      "stream_id TEXT",
      "summary TEXT",
      "input_json TEXT",
      "output_json TEXT",
      "progress_json TEXT",
      "last_signal_at INTEGER"
    ]) {
      this.#addColumnIfMissing(
        `ALTER TABLE cf_agent_tool_child_runs ADD COLUMN ${column}`
      );
    }
    sql.exec(`
      CREATE INDEX IF NOT EXISTS cf_agent_tool_child_runs_request_id
      ON cf_agent_tool_child_runs (request_id)
    `);
    // Durable milestones (rfc-detached-agent-tools §progress, 4b). One row per
    // milestone; `sequence` is monotonic per run so replay/live races dedupe.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agent_tool_milestones (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        name TEXT NOT NULL,
        data_json TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (run_id, sequence)
      )
    `);
  }

  #addColumnIfMissing(statement: string): void {
    try {
      this.lifecycle.storage.sql.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) throw error;
    }
  }

  /**
   * Fold pre-capability `@cloudflare/ai-chat` rows into the unified tables and
   * drop the legacy ones. `INSERT OR IGNORE` so a facet that somehow holds both
   * keeps the current rows. The legacy runs table has no `stream_id`; it is
   * re-derived from `request_id` on the next read.
   */
  #adoptLegacyTables(): void {
    const sql = this.lifecycle.storage.sql;
    const hasTable = (name: string) =>
      sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          name
        )
        .toArray().length > 0;

    if (hasTable(LEGACY_RUNS_TABLE)) {
      sql.exec(`
        INSERT OR IGNORE INTO cf_agent_tool_child_runs
          (run_id, request_id, status, summary, input_json, output_json,
           error_message, started_at, completed_at, progress_json,
           last_signal_at)
        SELECT run_id, request_id, status, summary, input_json, output_json,
               error_message, started_at, completed_at, progress_json,
               last_signal_at
        FROM ${LEGACY_RUNS_TABLE}
      `);
      sql.exec(`DROP TABLE ${LEGACY_RUNS_TABLE}`);
    }

    if (hasTable(LEGACY_MILESTONES_TABLE)) {
      sql.exec(`
        INSERT OR IGNORE INTO cf_agent_tool_milestones
          (run_id, sequence, name, data_json, at)
        SELECT run_id, sequence, name, data_json, at
        FROM ${LEGACY_MILESTONES_TABLE}
      `);
      sql.exec(`DROP TABLE ${LEGACY_MILESTONES_TABLE}`);
    }
  }

  #sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    // SAFETY: every query here selects from this capability's own schema; `T`
    // describes the projected columns of the accompanying query text.
    return [...this.lifecycle.storage.sql.exec(query, ...values)] as T[];
  }
}

/** Rebuild the latest `reportProgress` snapshot from a run row. */
function progressSnapshotFromRow(
  row: ChildRunRow
): AgentToolProgressSnapshot | undefined {
  if (row.progress_json == null || row.last_signal_at == null) return undefined;
  try {
    const parsed = JSON.parse(row.progress_json) as Partial<
      Omit<AgentToolProgressSnapshot, "at">
    >;
    return { ...parsed, at: row.last_signal_at };
  } catch {
    return { at: row.last_signal_at };
  }
}

function stringifyValue(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseValue(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
