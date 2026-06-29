import { applyChunkToParts, type MessagePart } from "./message-builder";
import {
  AGENT_TOOL_MILESTONE_PART,
  AGENT_TOOL_PROGRESS_PART
} from "../agent-tool-types";
import type {
  AgentToolEventMessage,
  AgentToolEventState,
  AgentToolMilestone,
  AgentToolProgress,
  AgentToolProgressSnapshot,
  AgentToolRunPart,
  AgentToolRunState,
  AgentToolStoredChunk
} from "../agent-tool-types";

/**
 * Pull a reserved `data-agent-progress` chunk (emitted by a running sub-agent's
 * `reportProgress`) into a latest-wins snapshot. Returns `undefined` for any
 * other chunk so the caller keeps the prior snapshot.
 */
function readAgentToolProgressChunk(
  chunk: unknown
): AgentToolProgressSnapshot | undefined {
  if (
    typeof chunk !== "object" ||
    chunk === null ||
    (chunk as { type?: unknown }).type !== AGENT_TOOL_PROGRESS_PART
  ) {
    return undefined;
  }
  const data = (chunk as { data?: AgentToolProgress }).data ?? {};
  return {
    ...(typeof data.fraction === "number" ? { fraction: data.fraction } : {}),
    ...(typeof data.message === "string" ? { message: data.message } : {}),
    ...(typeof data.phase === "string" ? { phase: data.phase } : {}),
    ...(data.data !== undefined ? { data: data.data } : {}),
    at: Date.now()
  };
}

/**
 * Pull a reserved `data-agent-milestone` chunk into a durable milestone record,
 * or `undefined` for any other chunk. Milestones carry their own monotonic
 * `sequence` so the caller can dedupe replay-vs-live races.
 */
function readAgentToolMilestoneChunk(
  chunk: unknown
): AgentToolMilestone | undefined {
  if (
    typeof chunk !== "object" ||
    chunk === null ||
    (chunk as { type?: unknown }).type !== AGENT_TOOL_MILESTONE_PART
  ) {
    return undefined;
  }
  const data = (chunk as { data?: Partial<AgentToolMilestone> }).data ?? {};
  if (typeof data.name !== "string") return undefined;
  return {
    name: data.name,
    sequence: typeof data.sequence === "number" ? data.sequence : 0,
    at: typeof data.at === "number" ? data.at : Date.now(),
    ...(data.data !== undefined ? { data: data.data } : {})
  };
}

/**
 * Merge a milestone into a run's ordered milestone list, deduping on `sequence`
 * (idempotent across replay + live races) and keeping the list sorted.
 */
function mergeMilestone(
  existing: AgentToolMilestone[] | undefined,
  milestone: AgentToolMilestone
): AgentToolMilestone[] {
  // Returns `existing` unchanged (same reference) when the milestone is a dup,
  // so callers can identity-compare to detect a genuinely new milestone.
  if (existing?.some((m) => m.sequence === milestone.sequence)) return existing;
  const list = existing ? [...existing, milestone] : [milestone];
  list.sort((a, b) => a.sequence - b.sequence);
  return list;
}

/** Latest-wins coalescing window for `reportProgress` emits (per run). */
const AGENT_TOOL_PROGRESS_COALESCE_MS = 200;

export type AgentToolProgressEmitResult = "emitted" | "coalesced" | "inactive";

/**
 * Host-injected seams the shared progress emitter needs. Keeps the per-host
 * `reportProgress` thin: Think / AIChatAgent supply how to resolve the active
 * agent-tool run, how to broadcast a chat-response frame, and how to persist the
 * latest snapshot on their own child-run table.
 */
export type AgentToolProgressEmitHooks = {
  /** The agent-tool run currently executing in this turn, or null. */
  resolveActiveRun: () => { runId: string; requestId: string } | null;
  /** Broadcast a chat-response frame (id = requestId) to clients/tailers. */
  broadcast: (requestId: string, chunkBody: string) => void;
  /** Persist the latest snapshot + signal timestamp on the child run row. */
  persistSnapshot: (
    runId: string,
    snapshot: {
      fraction?: number;
      message?: string;
      phase?: string;
      data?: unknown;
    },
    at: number
  ) => void;
  /**
   * Persist a durable milestone row, bump the run's signal timestamp, and return
   * the assigned monotonic per-run `sequence` (used to dedupe replay/live races).
   */
  persistMilestone: (
    runId: string,
    name: string,
    data: unknown,
    at: number
  ) => number;
};

/**
 * Shared implementation of `reportProgress` for chat hosts. Builds the reserved
 * transient `data-agent-progress` wire frame, coalesces bursts to a bounded
 * cadence (latest-wins; a `fraction >= 1` "done" frame always flushes), and
 * persists a latest snapshot. `data` rides the live frame but is only persisted
 * when the caller opts in via `{ persist: true }`.
 */
export class AgentToolProgressEmitter {
  private readonly _lastEmitAt = new Map<string, number>();

  constructor(private readonly hooks: AgentToolProgressEmitHooks) {}

  report(
    progress: AgentToolProgress,
    options?: { persist?: boolean }
  ): AgentToolProgressEmitResult {
    const active = this.hooks.resolveActiveRun();
    if (!active) return "inactive";
    const { runId, requestId } = active;
    const now = Date.now();

    // Durable milestone: never coalesced (each named boundary must land,
    // persist, and replay). Rides the stream as a PERSISTED data part.
    if (typeof progress.milestone === "string" && progress.milestone) {
      this._lastEmitAt.set(runId, now);
      const sequence = this.hooks.persistMilestone(
        runId,
        progress.milestone,
        progress.data,
        now
      );
      this.hooks.broadcast(
        requestId,
        JSON.stringify({
          type: AGENT_TOOL_MILESTONE_PART,
          data: {
            name: progress.milestone,
            sequence,
            at: now,
            ...(typeof progress.fraction === "number"
              ? { fraction: progress.fraction }
              : {}),
            ...(typeof progress.message === "string"
              ? { message: progress.message }
              : {}),
            ...(typeof progress.phase === "string"
              ? { phase: progress.phase }
              : {}),
            ...(progress.data !== undefined ? { data: progress.data } : {})
          }
        })
      );
      return "emitted";
    }

    const last = this._lastEmitAt.get(runId) ?? 0;
    const isDone =
      typeof progress.fraction === "number" && progress.fraction >= 1;
    if (now - last < AGENT_TOOL_PROGRESS_COALESCE_MS && !isDone) {
      return "coalesced";
    }
    this._lastEmitAt.set(runId, now);

    const wire: AgentToolProgress = {
      ...(typeof progress.fraction === "number"
        ? { fraction: progress.fraction }
        : {}),
      ...(typeof progress.message === "string"
        ? { message: progress.message }
        : {}),
      ...(typeof progress.phase === "string" ? { phase: progress.phase } : {}),
      ...(progress.data !== undefined ? { data: progress.data } : {})
    };
    this.hooks.broadcast(
      requestId,
      JSON.stringify({
        type: AGENT_TOOL_PROGRESS_PART,
        transient: true,
        data: wire
      })
    );
    this.hooks.persistSnapshot(
      runId,
      {
        ...(typeof progress.fraction === "number"
          ? { fraction: progress.fraction }
          : {}),
        ...(typeof progress.message === "string"
          ? { message: progress.message }
          : {}),
        ...(typeof progress.phase === "string"
          ? { phase: progress.phase }
          : {}),
        ...(options?.persist && progress.data !== undefined
          ? { data: progress.data }
          : {})
      },
      now
    );
    return "emitted";
  }

  /** Drop coalescing state for a settled run (called on terminal). */
  forget(runId: string): void {
    this._lastEmitAt.delete(runId);
  }
}

function sortRuns<Part extends AgentToolRunPart>(
  runs: AgentToolRunState<Part>[]
): AgentToolRunState<Part>[] {
  return [...runs].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.runId.localeCompare(b.runId);
  });
}

function rebuildIndexes<Part extends AgentToolRunPart>(
  runsById: Record<string, AgentToolRunState<Part>>
): Pick<AgentToolEventState<Part>, "runsByToolCallId" | "unboundRuns"> {
  const grouped: Record<string, AgentToolRunState<Part>[]> = {};
  const unboundRuns: AgentToolRunState<Part>[] = [];
  for (const run of Object.values(runsById)) {
    if (run.parentToolCallId) {
      grouped[run.parentToolCallId] = grouped[run.parentToolCallId] ?? [];
      grouped[run.parentToolCallId].push(run);
    } else {
      unboundRuns.push(run);
    }
  }
  for (const [toolCallId, runs] of Object.entries(grouped)) {
    grouped[toolCallId] = sortRuns(runs);
  }
  return { runsByToolCallId: grouped, unboundRuns: sortRuns(unboundRuns) };
}

function emptyRun<Part extends AgentToolRunPart>(
  message: AgentToolEventMessage
): AgentToolRunState<Part> | undefined {
  const { event } = message;
  if (event.kind === "started") {
    return {
      runId: event.runId,
      agentType: event.agentType,
      parentToolCallId: message.parentToolCallId,
      inputPreview: event.inputPreview,
      order: event.order,
      display: event.display,
      status: "running",
      parts: [],
      subAgent: { agent: event.agentType, name: event.runId }
    };
  }
  return undefined;
}

function applyToRun<Part extends AgentToolRunPart>(
  prev: AgentToolRunState<Part> | undefined,
  message: AgentToolEventMessage
): AgentToolRunState<Part> | undefined {
  const seeded = prev ?? emptyRun(message);
  const { event } = message;

  switch (event.kind) {
    case "started":
      if (
        seeded?.status === "completed" ||
        seeded?.status === "error" ||
        seeded?.status === "aborted" ||
        seeded?.status === "interrupted"
      ) {
        return seeded;
      }
      return {
        ...seeded,
        runId: event.runId,
        agentType: event.agentType,
        parentToolCallId: message.parentToolCallId,
        inputPreview: event.inputPreview,
        order: event.order,
        display: event.display,
        status: "running",
        parts: seeded?.parts ?? [],
        subAgent: { agent: event.agentType, name: event.runId }
      };
    case "chunk": {
      if (!seeded) return undefined;
      // `applyChunkToParts` mutates part objects in place (e.g.
      // `lastTextPart.text += delta`). A shallow array copy (`[...seeded.parts]`)
      // keeps the *element* references shared with the previous state, so those
      // in-place mutations leak back into `prev`. React double-invokes setState
      // updaters in StrictMode / dev hydration, replaying each chunk against the
      // same (already-mutated) `prev` and doubling the text (#1835). Clone each
      // part so the reducer stays pure — every mutation here is to a top-level
      // field, so a per-part shallow copy is sufficient.
      const parts = seeded.parts.map((part) => ({ ...part }) as Part);
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.body);
        applyChunkToParts(
          parts as MessagePart[],
          parsed as Parameters<typeof applyChunkToParts>[1]
        );
      } catch {
        return seeded;
      }
      // Project a reserved `data-agent-progress` part onto the run's latest
      // progress snapshot so a tray can render a bar/phase without drilling in.
      // The part is transient (not persisted into `parts`), so it is read here
      // off the raw chunk rather than from the reduced parts array.
      const progress = readAgentToolProgressChunk(parsed);
      if (progress) {
        return { ...seeded, parts, progress };
      }
      // Durable milestones land as a persisted `data-agent-milestone` part:
      // append (deduped by sequence) to the run's milestone list, and reflect
      // any progress fields the milestone carried onto the latest snapshot.
      const milestone = readAgentToolMilestoneChunk(parsed);
      if (milestone) {
        const milestones = mergeMilestone(seeded.milestones, milestone);
        // Only advance the snapshot for a genuinely new, not-older milestone, so
        // a late replay of an earlier milestone never rolls `progress` backward.
        const isNew = milestones !== seeded.milestones;
        const notOlder =
          seeded.progress === undefined || milestone.at >= seeded.progress.at;
        if (!isNew || !notOlder) {
          return { ...seeded, parts, milestones };
        }
        const data = (parsed as { data?: AgentToolProgress }).data ?? {};
        const snapshot: AgentToolProgressSnapshot = {
          ...(typeof data.fraction === "number"
            ? { fraction: data.fraction }
            : {}),
          ...(typeof data.message === "string"
            ? { message: data.message }
            : {}),
          ...(typeof data.phase === "string" ? { phase: data.phase } : {}),
          milestone: milestone.name,
          at: milestone.at
        };
        return { ...seeded, parts, progress: snapshot, milestones };
      }
      return { ...seeded, parts };
    }
    case "finished":
      if (!seeded) return undefined;
      return {
        ...seeded,
        status: "completed",
        summary: event.summary,
        error: undefined
      };
    case "error":
      if (!seeded) return undefined;
      return { ...seeded, status: "error", error: event.error };
    case "aborted":
      if (!seeded) return undefined;
      return { ...seeded, status: "aborted", error: event.reason };
    case "interrupted":
      if (!seeded) return undefined;
      return {
        ...seeded,
        status: "interrupted",
        error: event.error,
        reason: event.reason,
        childStillRunning: event.childStillRunning
      };
  }
}

export function createAgentToolEventState<
  Part extends AgentToolRunPart = AgentToolRunPart
>(): AgentToolEventState<Part> {
  return {
    runsById: {},
    runsByToolCallId: {},
    unboundRuns: []
  };
}

export function applyAgentToolEvent<
  Part extends AgentToolRunPart = AgentToolRunPart
>(
  state: AgentToolEventState<Part>,
  message: AgentToolEventMessage
): AgentToolEventState<Part> {
  if (message.type !== "agent-tool-event") return state;
  const runId = message.event.runId;
  const nextRun = applyToRun(state.runsById[runId], message);
  if (!nextRun) return state;

  const runsById = { ...state.runsById, [runId]: nextRun };
  return { runsById, ...rebuildIndexes(runsById) };
}

export type {
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolEventState,
  AgentToolRunPart,
  AgentToolRunState
} from "../agent-tool-types";

/**
 * @internal Host substrate the {@link interceptAgentToolBroadcast} snoop reads,
 * abstracting the divergent per-host run-lookup and response-frame constant.
 */
export interface AgentToolBroadcastHooks {
  /** Live tailers per run; iterated to forward each progress chunk. */
  forwarders: Map<string, Set<(chunk: AgentToolStoredChunk) => void>>;
  /**
   * Per-run forwarded-chunk counter; advanced even with no tailer attached.
   *
   * This is deliberately a SEPARATE counter from the resumable stream's stored
   * chunk_index — do NOT try to "simplify" it away by sequencing off the store
   * position. Not every forwarded frame is durably stored: progress/milestone
   * frames (`reportProgress`) ride the same `USE_CHAT_RESPONSE` wire type and
   * are snooped + forwarded here, but persist out-of-band (progress snapshot /
   * milestone rows), so they have no store position. Sourcing the sequence from
   * the store would give them a colliding position and the tail's high-water
   * dedupe (`emit`) would silently drop them, breaking live progress/milestone
   * delivery to the parent. This counter sequences stored AND non-stored frames
   * on one monotonic line; the tail realigns it to the stored high-water on each
   * (re)attach so a replay→live handoff stays gap/duplicate-free.
   */
  liveSequences: Map<string, number>;
  /** Per-run last error body, captured for replay to a late-attaching tailer. */
  lastErrors: Map<string, string>;
  /** The host's use-chat-response wire type (`CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE`). */
  responseType: string;
  /** Resolve the agent-tool run that owns a turn request id, or null. */
  runForRequest: (requestId: string) => string | null;
}

/**
 * Snoop a host's outgoing chat frames while any agent-tool run is in flight and
 * forward the owning run's streamed body to its live tailers (or capture its
 * error), without altering the frame — the caller still broadcasts it (#1575).
 *
 * Shared verbatim by `@cloudflare/ai-chat` and `@cloudflare/think`; the only
 * per-host variance (the response-frame type constant and the run-lookup, whose
 * SQL differs) is supplied via {@link AgentToolBroadcastHooks}. Inspection runs
 * for a run's whole lifecycle (live sequences exist even with no tailer), so
 * error capture never depends on tailer timing. A frame belongs to a run iff it
 * carries that run's turn request id, so concurrent runs can't cross-contaminate
 * each other's progress or error state.
 */
export function interceptAgentToolBroadcast(
  msg: string | ArrayBuffer | ArrayBufferView,
  hooks: AgentToolBroadcastHooks
): void {
  if (
    (hooks.forwarders.size > 0 || hooks.liveSequences.size > 0) &&
    typeof msg === "string"
  ) {
    try {
      const parsed = JSON.parse(msg) as {
        type?: unknown;
        body?: unknown;
        error?: unknown;
        id?: unknown;
      };
      if (parsed.type === hooks.responseType && typeof parsed.id === "string") {
        const runId = hooks.runForRequest(parsed.id);
        if (runId !== null) {
          if (parsed.error === true && typeof parsed.body === "string") {
            hooks.lastErrors.set(runId, parsed.body);
          } else if (
            typeof parsed.body === "string" &&
            parsed.body.length > 0
          ) {
            // Advance the live sequence even with no tailer attached so a tailer
            // registering mid-run resumes at the right offset.
            const sequence = hooks.liveSequences.get(runId) ?? 0;
            hooks.liveSequences.set(runId, sequence + 1);
            const chunk: AgentToolStoredChunk = { sequence, body: parsed.body };
            const forwarders = hooks.forwarders.get(runId);
            if (forwarders) {
              for (const forward of forwarders) forward(chunk);
            }
          }
        }
      }
    } catch {
      // Non-chat frames pass through unchanged.
    }
  }
}
