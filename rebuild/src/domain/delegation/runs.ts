import type { z } from "zod";
import { NotFoundError, toErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";
import type { AgentHandle } from "../../ports/agent-spawner.js";
import type { Tool, ToolExecutionContext } from "../tools/types.js";
import type { SubAgentRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Types (audit 19 §2)
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "completed" | "error" | "aborted";

export interface AgentToolRun {
  runId: string;
  agentType: string;
  status: RunStatus;
  displayName?: string;
  /** The child's chat requestId, once its relay reported onStart. */
  requestId?: string;
  summary?: string;
  output?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface AgentToolRunService {
  startRun(args: { agentClassName: string; prompt: string; displayName?: string }): Promise<AgentToolRun>;
  /** Resolves when the run reaches a terminal status (immediately if already terminal). */
  waitForRun(runId: string): Promise<AgentToolRun>;
  cancelRun(runId: string, reason?: string): Promise<void>;
  inspectRun(runId: string): AgentToolRun | null;
  hasRun(agentType: string, runId: string): boolean;
  listRuns(options?: { status?: RunStatus[] }): AgentToolRun[];
  /** Replay of the per-run event log; afterIndex returns only later events (tail). */
  readEvents(runId: string, afterIndex?: number): Array<{ index: number; event: unknown }>;
  /** Deletes run rows + event logs and destroys the retained child instances. */
  clearRuns(options?: { statuses?: RunStatus[]; before?: number }): Promise<number>;
  /** Startup recovery scan: settle stale "running" rows from live children. */
  reconcile(): Promise<void>;
}

export interface AgentToolRunHooks {
  onRunStart?: (run: AgentToolRun) => void;
  onRunFinish?: (run: AgentToolRun) => void;
  onProgress?: (runId: string, progress: unknown) => void;
}

/**
 * The relay handed to the child's chat entry — the original StreamCallback
 * shape. The child calls back into these as its turn streams/settles.
 */
export interface ChildChatRelay {
  onStart(info: { requestId: string }): void;
  onEvent(json: unknown): void;
  onDone(): void;
  onError(err: unknown): void;
  onInterrupted?(): void;
}

const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "error", "aborted"];
const DEFAULT_RECONCILE_DEADLINE_MS = 30_000;

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function eventKey(runId: string, index: number): string {
  return `evt:${runId}:${String(index).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createAgentToolRunService(deps: {
  store: KeyValueStore;
  registry: SubAgentRegistry;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  /** Live fan-out of relayed child events (the app layer broadcasts these). */
  onEvent?: (runId: string, event: unknown) => void;
  hooks?: AgentToolRunHooks;
  /** Bound on the total reconcile() scan time. Default 30s. */
  reconcileDeadlineMs?: number;
}): AgentToolRunService {
  const kv = scoped(deps.store, "run:");
  const waiters = new Map<string, Array<(run: AgentToolRun) => void>>();
  const eventCounters = new Map<string, number>();

  function getRow(runId: string): AgentToolRun | undefined {
    return kv.get<AgentToolRun>(`row:${runId}`);
  }

  function putRow(row: AgentToolRun): void {
    kv.put(`row:${runId(row)}`, row);
  }

  function runId(row: AgentToolRun): string {
    return row.runId;
  }

  function readEventLog(rid: string, afterIndex?: number): Array<{ index: number; event: unknown }> {
    const raw = kv.list<unknown>({ prefix: `evt:${rid}:` });
    const out: Array<{ index: number; event: unknown }> = [];
    for (const [key, event] of raw) {
      const index = Number.parseInt(key.slice(`evt:${rid}:`.length), 10);
      if (afterIndex !== undefined && index <= afterIndex) continue;
      out.push({ index, event });
    }
    return out;
  }

  function nextEventIndex(rid: string): number {
    let counter = eventCounters.get(rid);
    if (counter === undefined) {
      counter = kv.list({ prefix: `evt:${rid}:` }).size;
    }
    eventCounters.set(rid, counter + 1);
    return counter;
  }

  function appendEvent(rid: string, event: unknown): void {
    kv.put(eventKey(rid, nextEventIndex(rid)), event);
    deps.onEvent?.(rid, event);
    if (event !== null && typeof event === "object" && "progress" in event) {
      deps.hooks?.onProgress?.(rid, (event as { progress: unknown }).progress);
    }
  }

  /**
   * Concatenation of the run's streamed text: `delta` fields of relayed
   * `text-delta` UiChunks, plus bare string `text` fields for custom events.
   */
  function summarize(rid: string): string {
    let text = "";
    for (const { event } of readEventLog(rid)) {
      if (event === null || typeof event !== "object") continue;
      const e = event as { type?: unknown; delta?: unknown; text?: unknown };
      if (e.type === "text-delta" && typeof e.delta === "string") {
        text += e.delta;
      } else if (typeof e.text === "string") {
        text += e.text;
      }
    }
    return text;
  }

  /**
   * Applies a terminal transition. No-op when the row is missing or already
   * terminal (e.g. a child's late onDone after a cancel).
   */
  function settle(
    rid: string,
    patch: { status: Exclude<RunStatus, "running">; summary?: string; output?: unknown; error?: string }
  ): void {
    const row = getRow(rid);
    if (!row || isTerminal(row.status)) return;
    row.status = patch.status;
    if (patch.summary !== undefined) row.summary = patch.summary;
    if (patch.output !== undefined) row.output = patch.output;
    if (patch.error !== undefined) row.error = patch.error;
    row.completedAt = deps.clock.now();
    putRow(row);
    deps.bus.emit(`agent_tool:${patch.status}`, { runId: rid, agentType: row.agentType });
    deps.hooks?.onRunFinish?.(structuredClone(row));
    const pending = waiters.get(rid);
    if (pending) {
      waiters.delete(rid);
      for (const resolve of pending) resolve(structuredClone(row));
    }
  }

  function childHandle(row: AgentToolRun): AgentHandle {
    return deps.registry.get(row.agentType, row.runId);
  }

  function makeRelay(rid: string): ChildChatRelay {
    return {
      onStart(info) {
        const row = getRow(rid);
        if (!row) return;
        row.requestId = info.requestId;
        putRow(row);
      },
      onEvent(json) {
        appendEvent(rid, json);
      },
      onDone() {
        settle(rid, { status: "completed", summary: summarize(rid) });
      },
      onError(err) {
        settle(rid, { status: "error", error: toErrorValue(err).message });
      },
      onInterrupted() {
        // A child continuation owns the outcome; the run stays "running" and
        // either the same relay settles it later or reconcile() observes the
        // real terminal state on parent restart.
        deps.bus.emit("agent_tool:interrupted", { runId: rid });
      },
    };
  }

  return {
    async startRun(args) {
      const rid = deps.ids.newId("run");
      const row: AgentToolRun = {
        runId: rid,
        agentType: args.agentClassName,
        status: "running",
        startedAt: deps.clock.now(),
      };
      if (args.displayName !== undefined) row.displayName = args.displayName;
      putRow(row);
      deps.bus.emit("agent_tool:start", { runId: rid, agentType: args.agentClassName });
      deps.hooks?.onRunStart?.(structuredClone(row));

      // Each run gets a fresh child instance named after the run; it is
      // retained after completion for drill-in and destroyed by clearRuns().
      const handle = deps.registry.get(args.agentClassName, rid);
      const relay = makeRelay(rid);
      const snapshot = structuredClone(row);
      void handle.call("chat", [args.prompt, relay]).catch((err: unknown) => {
        settle(rid, { status: "error", error: toErrorValue(err).message });
      });
      return snapshot;
    },

    async waitForRun(rid) {
      const row = getRow(rid);
      if (!row) throw new NotFoundError(`Unknown agent-tool run: ${rid}`);
      if (isTerminal(row.status)) return row;
      return new Promise<AgentToolRun>((resolve) => {
        const pending = waiters.get(rid);
        if (pending) {
          pending.push(resolve);
        } else {
          waiters.set(rid, [resolve]);
        }
      });
    },

    async cancelRun(rid, reason) {
      const row = getRow(rid);
      if (!row) throw new NotFoundError(`Unknown agent-tool run: ${rid}`);
      if (isTerminal(row.status)) return;

      const handle = childHandle(row);
      if (row.requestId !== undefined) {
        try {
          await handle.call("cancelChat", [row.requestId]);
        } catch {
          handle.abort(reason);
        }
      } else {
        handle.abort(reason);
      }
      settle(rid, reason === undefined ? { status: "aborted" } : { status: "aborted", error: reason });
    },

    inspectRun(rid) {
      return getRow(rid) ?? null;
    },

    hasRun(agentType, rid) {
      const row = getRow(rid);
      return row !== undefined && row.agentType === agentType;
    },

    listRuns(options) {
      const rows = [...kv.list<AgentToolRun>({ prefix: "row:" }).values()];
      const filtered = options?.status ? rows.filter((r) => options.status!.includes(r.status)) : rows;
      return filtered.sort((a, b) => a.startedAt - b.startedAt);
    },

    readEvents(rid, afterIndex) {
      return readEventLog(rid, afterIndex);
    },

    async clearRuns(options) {
      const statuses = options?.statuses ?? TERMINAL_STATUSES;
      const rows = [...kv.list<AgentToolRun>({ prefix: "row:" }).values()];
      let count = 0;
      for (const row of rows) {
        if (!statuses.includes(row.status)) continue;
        if (options?.before !== undefined && row.startedAt >= options.before) continue;
        kv.delete(`row:${row.runId}`);
        kv.deleteAll({ prefix: `evt:${row.runId}:` });
        eventCounters.delete(row.runId);
        await deps.registry.delete(row.agentType, row.runId);
        count++;
      }
      return count;
    },

    async reconcile() {
      const stale = [...kv.list<AgentToolRun>({ prefix: "row:" }).values()].filter((r) => r.status === "running");
      deps.bus.emit("agent_tool:recovery:begin", { count: stale.length });
      const deadlineAt = deps.clock.now() + (deps.reconcileDeadlineMs ?? DEFAULT_RECONCILE_DEADLINE_MS);
      try {
        for (const row of stale) {
          if (deps.clock.now() >= deadlineAt) {
            deps.bus.emit("agent_tool:recovery:deadline", { runId: row.runId });
            break;
          }
          let observed: { status: string; output?: unknown; error?: string } | null;
          try {
            observed = await childHandle(row).call<{ status: string; output?: unknown; error?: string } | null>(
              "inspectRun",
              [row.runId]
            );
          } catch {
            observed = null; // unreachable child
          }

          if (observed?.status === "completed") {
            const summary = typeof observed.output === "string" ? observed.output : undefined;
            settle(
              row.runId,
              summary === undefined
                ? { status: "completed", output: observed.output }
                : { status: "completed", output: observed.output, summary }
            );
            deps.bus.emit("agent_tool:recovery:row", { runId: row.runId, status: "completed" });
          } else if (observed?.status === "error" || observed?.status === "aborted") {
            settle(row.runId, { status: observed.status, error: observed.error ?? "child reported failure" });
            deps.bus.emit("agent_tool:recovery:row", { runId: row.runId, status: observed.status });
          } else if (observed === null || observed === undefined) {
            settle(row.runId, { status: "error", error: "lost" });
            deps.bus.emit("agent_tool:recovery:row", { runId: row.runId, status: "error", reason: "lost" });
          } else {
            // Child says it is still working on it: leave the row running.
            deps.bus.emit("agent_tool:recovery:row", { runId: row.runId, status: "running" });
          }
        }
        deps.bus.emit("agent_tool:recovery:complete", {});
      } catch (err) {
        deps.bus.emit("agent_tool:recovery:failed", { error: toErrorValue(err).message });
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool factory (audit 19 §2): execute = startRun + wait for terminal
// ---------------------------------------------------------------------------

export function agentTool(
  agentClassName: string,
  cfg: {
    description: string;
    inputSchema: z.ZodType;
    displayName?: string;
    /** Build the child prompt from tool input. Default: JSON.stringify(input). */
    prompt?: (input: unknown) => string;
  },
  deps: { runs: AgentToolRunService }
): Tool {
  return {
    description: cfg.description,
    inputSchema: cfg.inputSchema,
    metadata: { capability: "delegation", agentClassName },
    async execute(input: unknown, ctx: ToolExecutionContext): Promise<unknown> {
      const prompt = cfg.prompt ? cfg.prompt(input) : JSON.stringify(input);
      const startArgs: { agentClassName: string; prompt: string; displayName?: string } = { agentClassName, prompt };
      if (cfg.displayName !== undefined) startArgs.displayName = cfg.displayName;
      const run = await deps.runs.startRun(startArgs);

      const onAbort = (): void => {
        void deps.runs.cancelRun(run.runId, "parent turn aborted").catch(() => {});
      };
      if (ctx.signal.aborted) {
        onAbort();
      } else {
        ctx.signal.addEventListener("abort", onAbort);
      }

      try {
        const finished = await deps.runs.waitForRun(run.runId);
        if (finished.status === "completed") {
          return finished.output ?? finished.summary ?? "";
        }
        const name = finished.status === "aborted" ? "AbortedError" : "AgentToolError";
        return { error: { name, message: finished.error ?? `agent-tool run ${finished.status}` } };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
