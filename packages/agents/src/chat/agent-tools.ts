import { applyChunkToParts } from "./message-builder";
import type {
  AgentToolEventMessage,
  AgentToolEventState,
  AgentToolRunState,
  AgentToolStoredChunk
} from "../agent-tool-types";

function sortRuns(runs: AgentToolRunState[]): AgentToolRunState[] {
  return [...runs].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.runId.localeCompare(b.runId);
  });
}

function rebuildIndexes(
  runsById: Record<string, AgentToolRunState>
): Pick<AgentToolEventState, "runsByToolCallId" | "unboundRuns"> {
  const grouped: Record<string, AgentToolRunState[]> = {};
  const unboundRuns: AgentToolRunState[] = [];
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

function emptyRun(
  message: AgentToolEventMessage
): AgentToolRunState | undefined {
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

function applyToRun(
  prev: AgentToolRunState | undefined,
  message: AgentToolEventMessage
): AgentToolRunState | undefined {
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
      const parts = [...seeded.parts];
      try {
        applyChunkToParts(parts, JSON.parse(event.body));
      } catch {
        return seeded;
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

export function createAgentToolEventState(): AgentToolEventState {
  return {
    runsById: {},
    runsByToolCallId: {},
    unboundRuns: []
  };
}

export function applyAgentToolEvent(
  state: AgentToolEventState,
  message: AgentToolEventMessage
): AgentToolEventState {
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
  AgentToolRunState
} from "../agent-tool-types";

/**
 * @internal Host substrate the {@link interceptAgentToolBroadcast} snoop reads,
 * abstracting the divergent per-host run-lookup and response-frame constant.
 */
export interface AgentToolBroadcastHooks {
  /** Live tailers per run; iterated to forward each progress chunk. */
  forwarders: Map<string, Set<(chunk: AgentToolStoredChunk) => void>>;
  /** Per-run forwarded-chunk counter; advanced even with no tailer attached. */
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
