import { ConflictError, NotFoundError, toErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";
import type { WorkflowRuntime } from "../../ports/workflow-runtime.js";

export type WorkflowStatus = "running" | "paused" | "completed" | "errored" | "terminated";

export interface WorkflowInfo {
  workflowId: string;
  workflowName: string;
  status: WorkflowStatus;
  params?: unknown;
  metadata?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowService {
  run(
    workflowName: string,
    options?: { id?: string; params?: unknown; metadata?: Record<string, unknown> }
  ): Promise<WorkflowInfo>;
  sendEvent(workflowId: string, event: { type: string; payload?: unknown }): Promise<void>;
  approve(workflowId: string, reason?: string): Promise<void>;
  reject(workflowId: string, reason?: string): Promise<void>;
  terminate(workflowId: string): Promise<void>;
  pause(workflowId: string): Promise<void>;
  resume(workflowId: string): Promise<void>;
  restart(workflowId: string): Promise<void>;
  status(workflowId: string): Promise<WorkflowInfo>;
  get(workflowId: string): WorkflowInfo | undefined;
  list(criteria?: {
    status?: WorkflowStatus[];
    workflowName?: string;
    limit?: number;
    offset?: number;
  }): { workflows: WorkflowInfo[]; total: number };
  delete(workflowId: string): boolean;
  deleteMany(criteria?: { status?: WorkflowStatus[]; updatedBefore?: number }): number;
  migrateBinding(oldName: string, newName: string): number;
  onCallback(cb: {
    workflowId: string;
    kind: "progress" | "complete" | "error";
    payload?: unknown;
  }): Promise<{ recognized: boolean }>;
}

const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set(["completed", "errored", "terminated"]);
const SETTLED_STATUSES: WorkflowStatus[] = ["completed", "errored", "terminated"];

function isTerminal(status: string): status is WorkflowStatus {
  return TERMINAL_STATUSES.has(status as WorkflowStatus);
}

function errorMessageOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  return toErrorValue(payload).message;
}

export function createWorkflowService(deps: {
  store: KeyValueStore;
  runtime: WorkflowRuntime;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  hooks?: {
    onProgress?: (wf: WorkflowInfo, payload: unknown) => void | Promise<void>;
    onComplete?: (wf: WorkflowInfo) => void | Promise<void>;
  };
}): WorkflowService {
  const kv = scoped(deps.store, "wf:");

  function getRow(workflowId: string): WorkflowInfo | undefined {
    return kv.get<WorkflowInfo>(workflowId);
  }

  function requireRow(workflowId: string): WorkflowInfo {
    const row = getRow(workflowId);
    if (!row) throw new NotFoundError(`Unknown workflow: ${workflowId}`);
    return row;
  }

  function save(row: WorkflowInfo): void {
    kv.put(row.workflowId, row);
  }

  async function transition(
    workflowId: string,
    runtimeCall: (row: WorkflowInfo) => Promise<void>,
    nextStatus: WorkflowStatus,
    eventType: string
  ): Promise<void> {
    const row = requireRow(workflowId);
    await runtimeCall(row);
    row.status = nextStatus;
    row.updatedAt = deps.clock.now();
    save(row);
    deps.bus.emit(eventType, { workflowId });
  }

  return {
    async run(workflowName, options) {
      const workflowId = options?.id ?? deps.ids.newId("wf");
      const existing = getRow(workflowId);
      if (existing && !TERMINAL_STATUSES.has(existing.status)) {
        throw new ConflictError(`Workflow ${workflowId} already has a live run`);
      }

      const now = deps.clock.now();
      const row: WorkflowInfo = {
        workflowId,
        workflowName,
        status: "running",
        params: options?.params,
        metadata: options?.metadata,
        createdAt: now,
        updatedAt: now,
      };
      save(row);
      await deps.runtime.create(workflowName, { id: workflowId, params: options?.params });
      deps.bus.emit("workflow:start", { workflowId, workflowName });
      return row;
    },

    async sendEvent(workflowId, event) {
      const row = requireRow(workflowId);
      await deps.runtime.sendEvent(row.workflowName, workflowId, event);
      deps.bus.emit("workflow:event", { workflowId, event });
    },

    async approve(workflowId, reason) {
      const row = requireRow(workflowId);
      await deps.runtime.sendEvent(row.workflowName, workflowId, {
        type: "approval",
        payload: { approved: true, reason },
      });
      deps.bus.emit("workflow:approved", { workflowId, reason });
    },

    async reject(workflowId, reason) {
      const row = requireRow(workflowId);
      await deps.runtime.sendEvent(row.workflowName, workflowId, {
        type: "approval",
        payload: { approved: false, reason },
      });
      deps.bus.emit("workflow:rejected", { workflowId, reason });
    },

    async terminate(workflowId) {
      await transition(workflowId, (row) => deps.runtime.terminate(row.workflowName, workflowId), "terminated", "workflow:terminated");
    },

    async pause(workflowId) {
      await transition(workflowId, (row) => deps.runtime.pause(row.workflowName, workflowId), "paused", "workflow:paused");
    },

    async resume(workflowId) {
      await transition(workflowId, (row) => deps.runtime.resume(row.workflowName, workflowId), "running", "workflow:resumed");
    },

    async restart(workflowId) {
      const row = requireRow(workflowId);
      await deps.runtime.restart(row.workflowName, workflowId);
      row.status = "running";
      row.output = undefined;
      row.error = undefined;
      row.updatedAt = deps.clock.now();
      save(row);
      deps.bus.emit("workflow:restarted", { workflowId });
    },

    async status(workflowId) {
      const row = requireRow(workflowId);
      const runtimeStatus = await deps.runtime.status(row.workflowName, workflowId);
      if (runtimeStatus && isTerminal(runtimeStatus.status)) {
        row.status = runtimeStatus.status;
        row.output = runtimeStatus.output;
        row.error = runtimeStatus.error;
        row.updatedAt = deps.clock.now();
        save(row);
      }
      return row;
    },

    get(workflowId) {
      return getRow(workflowId);
    },

    list(criteria) {
      const rows = [...kv.list<WorkflowInfo>().values()];
      const filtered = rows.filter((row) => {
        if (criteria?.status && !criteria.status.includes(row.status)) return false;
        if (criteria?.workflowName && row.workflowName !== criteria.workflowName) return false;
        return true;
      });
      const total = filtered.length;
      const offset = criteria?.offset ?? 0;
      const limit = criteria?.limit;
      const page = limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
      return { workflows: page, total };
    },

    delete(workflowId) {
      return kv.delete(workflowId);
    },

    deleteMany(criteria) {
      const statuses = criteria?.status ?? SETTLED_STATUSES;
      const rows = [...kv.list<WorkflowInfo>().values()];
      let count = 0;
      for (const row of rows) {
        if (!statuses.includes(row.status)) continue;
        if (criteria?.updatedBefore !== undefined && row.updatedAt >= criteria.updatedBefore) continue;
        kv.delete(row.workflowId);
        count++;
      }
      return count;
    },

    migrateBinding(oldName, newName) {
      const rows = [...kv.list<WorkflowInfo>().values()];
      let count = 0;
      for (const row of rows) {
        if (row.workflowName !== oldName) continue;
        row.workflowName = newName;
        save(row);
        count++;
      }
      return count;
    },

    async onCallback(cb) {
      const row = getRow(cb.workflowId);
      if (!row) return { recognized: false };

      if (cb.kind === "progress") {
        row.updatedAt = deps.clock.now();
        save(row);
        await deps.hooks?.onProgress?.(row, cb.payload);
        return { recognized: true };
      }

      if (cb.kind === "complete") {
        row.status = "completed";
        row.output = cb.payload;
        row.updatedAt = deps.clock.now();
        save(row);
        await deps.hooks?.onComplete?.(row);
        return { recognized: true };
      }

      // "error"
      row.status = "errored";
      row.error = errorMessageOf(cb.payload);
      row.updatedAt = deps.clock.now();
      save(row);
      return { recognized: true };
    },
  };
}
