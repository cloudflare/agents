import { applyChunkToParts } from "./message-builder";
import type {
  AgentToolEventMessage,
  AgentToolEventState,
  AgentToolRunState
} from "../agent-tool-types";

const EMPTY_STATE: AgentToolEventState = {
  runsById: {},
  runsByToolCallId: {},
  unboundRuns: []
};

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
      return { ...seeded, status: "interrupted", error: event.error };
  }
}

export function createAgentToolEventState(): AgentToolEventState {
  return EMPTY_STATE;
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
