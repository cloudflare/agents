/**
 * Workflows: start Cloudflare Workflow instances on behalf of an agent,
 * control them, and keep a local record of each one.
 *
 * The Workflows service is the truth for an instance's status. This
 * capability keeps a mirror in `cf_agents_workflows`: one row per instance
 * started through `run()`, updated by the control calls and by the
 * callbacks an `AgentWorkflow` reports back (`record()`). Nothing lives only
 * in memory.
 */

import { nanoid } from "nanoid";
import { LifecycleCapability } from "../lifecycle/capability";
import { isErrorRetryable, tryN } from "../retries";
import { SqlError } from "../sql-error";
import type { AgentPathStep } from "../sub-routing";
import { camelCaseToKebabCase } from "../utils";
import type {
  AgentWorkflowOrigin,
  RunWorkflowOptions,
  WorkflowCallback,
  WorkflowEventPayload,
  WorkflowInfo,
  WorkflowPage,
  WorkflowQueryCriteria,
  WorkflowStatus,
  WorkflowTrackingRow
} from "../workflow-types";

/**
 * Who started the workflows: a top-level agent, or a facet by its path.
 *
 * @internal
 */
export type WorkflowOwner =
  | {
      readonly kind: "agent";
      readonly className: string;
      readonly name: string;
    }
  | {
      readonly kind: "facet";
      readonly name: string;
      readonly path: ReadonlyArray<AgentPathStep>;
    };

/** @internal */
export type WorkflowsOptions = {
  /** The Worker env holding the Workflow and agent namespace bindings. */
  readonly env: object;
  /** The owner, read when a workflow starts. */
  readonly owner: () => WorkflowOwner;
};

/** @internal */
export type WorkflowFilter = Omit<
  WorkflowQueryCriteria,
  "limit" | "cursor" | "orderBy"
> & { createdBefore?: Date };

const SCHEMA_VERSION_KEY = "cf_agents:workflows_schema_version";
const CURRENT_SCHEMA_VERSION = 1;

const TERMINAL: readonly WorkflowStatus[] = [
  "complete",
  "errored",
  "terminated"
];

const RETRY = {
  shouldRetry: isErrorRetryable,
  baseDelayMs: 200,
  maxDelayMs: 3000
};

type SqlValue = string | number | boolean | null;

/**
 * The options `workflow.create()` gets: owner identity rides in the params.
 *
 * @internal
 */
export function workflowCreateOptions(args: {
  workflowId: string;
  workflowName: string;
  params: unknown;
  agentName: string;
  origin: AgentWorkflowOrigin;
  retention?: RunWorkflowOptions["retention"];
}): WorkflowInstanceCreateOptions {
  const { origin } = args;
  return {
    id: args.workflowId,
    params: {
      ...(args.params as object),
      __agentName: args.agentName,
      __agentBinding:
        origin.kind === "agent" ? origin.binding : origin.rootBinding,
      __workflowName: args.workflowName,
      __agentOrigin: origin
    },
    retention: args.retention
  };
}

function isWorkflowBinding(value: unknown): value is Workflow {
  return (
    value !== null &&
    typeof value === "object" &&
    "create" in value &&
    "get" in value
  );
}

function infoFromRow(row: WorkflowTrackingRow): WorkflowInfo {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    error: row.error_name
      ? { name: row.error_name, message: row.error_message ?? "" }
      : null,
    createdAt: new Date(row.created_at * 1000),
    updatedAt: new Date(row.updated_at * 1000),
    completedAt: row.completed_at ? new Date(row.completed_at * 1000) : null
  };
}

function encodeCursor(workflow: WorkflowInfo): string {
  return btoa(
    JSON.stringify({
      c: Math.floor(workflow.createdAt.getTime() / 1000),
      i: workflow.workflowId
    })
  );
}

function decodeCursor(cursor: string): {
  createdAt: number;
  workflowId: string;
} {
  try {
    const data = JSON.parse(atob(cursor));
    if (typeof data.c !== "number" || typeof data.i !== "string") {
      throw new Error("Invalid cursor structure");
    }
    return { createdAt: data.c, workflowId: data.i };
  } catch {
    throw new Error(
      "Invalid pagination cursor. The cursor may be malformed or corrupted."
    );
  }
}

/** The WHERE clause and parameters for a filter. */
function whereClause(filter: WorkflowFilter): {
  sql: string;
  params: SqlValue[];
} {
  let sql = " WHERE 1=1";
  const params: SqlValue[] = [];
  if (filter.status) {
    const statuses = Array.isArray(filter.status)
      ? filter.status
      : [filter.status];
    sql += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }
  if (filter.workflowName) {
    sql += " AND workflow_name = ?";
    params.push(filter.workflowName);
  }
  if (filter.metadata) {
    for (const [key, value] of Object.entries(filter.metadata)) {
      sql += ` AND json_extract(metadata, '$.' || ?) = ?`;
      params.push(key, value);
    }
  }
  if (filter.createdBefore) {
    sql += " AND created_at < ?";
    params.push(Math.floor(filter.createdBefore.getTime() / 1000));
  }
  return { sql, params };
}

/** @internal */
export class Workflows extends LifecycleCapability {
  readonly #options: WorkflowsOptions;
  #tableReady = false;

  constructor(options: WorkflowsOptions) {
    super("workflows");
    this.#options = options;
  }

  /** Warn about tracked rows whose binding is gone (a renamed binding). */
  onStart(): void {
    const rows = this.#sql<{
      workflow_name: string;
      total: number;
      active: number;
      completed: number;
    }>`
      SELECT
        workflow_name,
        COUNT(*) as total,
        SUM(CASE WHEN status NOT IN ('complete', 'errored', 'terminated') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status IN ('complete', 'errored', 'terminated') THEN 1 ELSE 0 END) as completed
      FROM cf_agents_workflows
      GROUP BY workflow_name
    `;
    const orphaned = rows.filter((row) => !this.#binding(row.workflow_name));
    if (orphaned.length === 0) return;

    const current = this.#bindingNames();
    for (const {
      workflow_name: oldName,
      total,
      active,
      completed
    } of orphaned) {
      const suggestion =
        current.length === 1
          ? `this.migrateWorkflowBinding('${oldName}', '${current[0]}')`
          : `this.migrateWorkflowBinding('${oldName}', '<NEW_BINDING_NAME>')`;
      const breakdown =
        active > 0 && completed > 0
          ? ` (${active} active, ${completed} completed)`
          : active > 0
            ? ` (${active} active)`
            : ` (${completed} completed)`;
      console.warn(
        `[Agent] Found ${total} workflow(s) referencing unknown binding '${oldName}'${breakdown}. ` +
          `If you renamed the binding, call: ${suggestion}`
      );
    }
  }

  // ── Starting and controlling ─────────────────────────────────────────────

  /** Start an instance, track it, and return its id. */
  async run(
    workflowName: string,
    params: unknown,
    options?: RunWorkflowOptions
  ): Promise<string> {
    const workflow = this.#requireBinding(workflowName);
    const owner = this.#options.owner();
    const origin = this.#origin(owner, options?.agentBinding);
    if (!origin) {
      throw new Error(
        "Could not detect Agent binding name from class name. " +
          "Pass it explicitly via options.agentBinding"
      );
    }

    // Workflows instance IDs must start with [a-zA-Z0-9_].
    const workflowId = options?.id ?? `wf_${nanoid()}`;
    const instance = await workflow.create(
      workflowCreateOptions({
        workflowId,
        workflowName,
        params,
        agentName: owner.name,
        origin,
        retention: options?.retention
      })
    );

    const metadata = options?.metadata
      ? JSON.stringify(options.metadata)
      : null;
    try {
      this.#sql`
        INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status, metadata)
        VALUES (${nanoid()}, ${instance.id}, ${workflowName}, 'queued', ${metadata})
      `;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(
          `Workflow with ID "${workflowId}" is already being tracked`
        );
      }
      throw e;
    }

    this.#emit("workflow:start", { workflowId: instance.id, workflowName });
    return instance.id;
  }

  /** Send an event a running instance can wait for with `step.waitForEvent()`. */
  async sendEvent(
    workflowName: string,
    workflowId: string,
    event: WorkflowEventPayload
  ): Promise<void> {
    const instance = await this.#requireBinding(workflowName).get(workflowId);
    await tryN(3, async () => instance.sendEvent(event), RETRY);
    this.#emit("workflow:event", { workflowId, eventType: event.type });
  }

  /** Approve a tracked instance waiting in `waitForApproval()`. */
  async approve(
    workflowId: string,
    data?: { reason?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    await this.sendEvent(
      this.#requireTracked(workflowId).workflowName,
      workflowId,
      {
        type: "approval",
        payload: {
          approved: true,
          reason: data?.reason,
          metadata: data?.metadata
        }
      }
    );
    this.#emit("workflow:approved", { workflowId, reason: data?.reason });
  }

  /** Reject a tracked instance waiting in `waitForApproval()`. */
  async reject(workflowId: string, data?: { reason?: string }): Promise<void> {
    await this.sendEvent(
      this.#requireTracked(workflowId).workflowName,
      workflowId,
      {
        type: "approval",
        payload: { approved: false, reason: data?.reason }
      }
    );
    this.#emit("workflow:rejected", { workflowId, reason: data?.reason });
  }

  terminate(workflowId: string): Promise<void> {
    return this.#control(workflowId, "terminate", "workflow:terminated");
  }

  pause(workflowId: string): Promise<void> {
    return this.#control(workflowId, "pause", "workflow:paused");
  }

  resume(workflowId: string): Promise<void> {
    return this.#control(workflowId, "resume", "workflow:resumed");
  }

  /**
   * Re-run a tracked instance from the start. `resetTracking` (default
   * true) resets its record as if it had just been queued.
   */
  async restart(
    workflowId: string,
    options: { resetTracking?: boolean } = {}
  ): Promise<void> {
    const { resetTracking = true } = options;
    await this.#control(workflowId, "restart", "workflow:restarted", () => {
      if (!resetTracking) return false;
      const now = Math.floor(Date.now() / 1000);
      this.#sql`
        UPDATE cf_agents_workflows
        SET status = 'queued',
            created_at = ${now},
            updated_at = ${now},
            completed_at = NULL,
            error_name = NULL,
            error_message = NULL
        WHERE workflow_id = ${workflowId}
      `;
      return true;
    });
  }

  /** Read an instance's status from the service and update its record. */
  async status(
    workflowName: string,
    workflowId: string
  ): Promise<InstanceStatus> {
    const instance = await this.#requireBinding(workflowName).get(workflowId);
    const status = await instance.status();
    this.#updateFromStatus(workflowId, status);
    return status;
  }

  async #control(
    workflowId: string,
    operation: "terminate" | "pause" | "resume" | "restart",
    event:
      | "workflow:terminated"
      | "workflow:paused"
      | "workflow:resumed"
      | "workflow:restarted",
    afterOperation?: () => boolean
  ): Promise<void> {
    const tracked = this.#requireTracked(workflowId);
    const workflow = this.#binding(tracked.workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${tracked.workflowName}' not found in environment`
      );
    }
    const instance = await workflow.get(workflowId);
    await tryN(3, async () => instance[operation](), RETRY);
    if (!afterOperation?.()) {
      this.#updateFromStatus(workflowId, await instance.status());
    }
    this.#emit(event, { workflowId, workflowName: tracked.workflowName });
  }

  // ── Callbacks from AgentWorkflow ─────────────────────────────────────────

  /**
   * Apply the status change a workflow callback implies. Progress moves a
   * queued or waiting instance to running; complete and error never
   * overwrite terminated or paused; events change nothing.
   */
  record(callback: WorkflowCallback): void {
    const now = Math.floor(Date.now() / 1000);
    switch (callback.type) {
      case "progress":
        this.#sql`
          UPDATE cf_agents_workflows
          SET status = 'running', updated_at = ${now}
          WHERE workflow_id = ${callback.workflowId} AND status IN ('queued', 'waiting')
        `;
        return;
      case "complete":
        this.#sql`
          UPDATE cf_agents_workflows
          SET status = 'complete', updated_at = ${now}, completed_at = ${now}
          WHERE workflow_id = ${callback.workflowId}
            AND status NOT IN ('terminated', 'paused')
        `;
        return;
      case "error":
        this.#sql`
          UPDATE cf_agents_workflows
          SET status = 'errored', updated_at = ${now}, completed_at = ${now},
              error_name = 'WorkflowError', error_message = ${callback.error}
          WHERE workflow_id = ${callback.workflowId}
            AND status NOT IN ('terminated', 'paused')
        `;
        return;
      case "event":
        return;
    }
  }

  // ── Records ──────────────────────────────────────────────────────────────

  get(workflowId: string): WorkflowInfo | undefined {
    const row = this.#sql<WorkflowTrackingRow>`
      SELECT * FROM cf_agents_workflows WHERE workflow_id = ${workflowId}
    `[0];
    return row ? infoFromRow(row) : undefined;
  }

  /** Query records with keyset pagination, newest first by default. */
  list(criteria: WorkflowQueryCriteria = {}): WorkflowPage {
    const limit = Math.min(criteria.limit ?? 50, 100);
    const isAsc = criteria.orderBy === "asc";
    const where = whereClause(criteria);
    let query = `SELECT * FROM cf_agents_workflows${where.sql}`;
    const params = [...where.params];

    if (criteria.cursor) {
      const cursor = decodeCursor(criteria.cursor);
      query += isAsc
        ? " AND (created_at > ? OR (created_at = ? AND workflow_id > ?))"
        : " AND (created_at < ? OR (created_at = ? AND workflow_id < ?))";
      params.push(cursor.createdAt, cursor.createdAt, cursor.workflowId);
    }
    const order = isAsc ? "ASC" : "DESC";
    query += ` ORDER BY created_at ${order}, workflow_id ${order} LIMIT ?`;
    // One extra row tells whether another page exists.
    params.push(limit + 1);

    const rows = this.#query<WorkflowTrackingRow>(query, params);
    const hasMore = rows.length > limit;
    const workflows = (hasMore ? rows.slice(0, limit) : rows).map(infoFromRow);
    return {
      workflows,
      total: this.#count(criteria),
      nextCursor:
        hasMore && workflows.length > 0
          ? encodeCursor(workflows[workflows.length - 1])
          : null
    };
  }

  /** Delete one record. False when there was none. */
  delete(workflowId: string): boolean {
    if (!this.get(workflowId)) return false;
    this.#sql`DELETE FROM cf_agents_workflows WHERE workflow_id = ${workflowId}`;
    return true;
  }

  /** Delete the records matching a filter and return how many went. */
  deleteMany(filter: WorkflowFilter = {}): number {
    const where = whereClause(filter);
    return this.#write(
      `DELETE FROM cf_agents_workflows${where.sql}`,
      where.params
    );
  }

  /** Point records at a renamed binding and return how many moved. */
  migrateBinding(oldName: string, newName: string): number {
    if (!this.#binding(newName)) {
      throw new Error(`Workflow binding '${newName}' not found in environment`);
    }
    const count =
      this.#sql<{ count: number }>`
        SELECT COUNT(*) as count FROM cf_agents_workflows WHERE workflow_name = ${oldName}
      `[0]?.count ?? 0;
    if (count > 0) {
      this.#sql`
        UPDATE cf_agents_workflows SET workflow_name = ${newName} WHERE workflow_name = ${oldName}
      `;
      console.log(
        `[Agent] Migrated ${count} workflow(s) from '${oldName}' to '${newName}'`
      );
    }
    return count;
  }

  #count(filter: WorkflowFilter): number {
    const where = whereClause(filter);
    return (
      this.#query<{ count: number }>(
        `SELECT COUNT(*) as count FROM cf_agents_workflows${where.sql}`,
        where.params
      )[0]?.count ?? 0
    );
  }

  #updateFromStatus(workflowId: string, status: InstanceStatus): void {
    const now = Math.floor(Date.now() / 1000);
    const completedAt = TERMINAL.includes(status.status) ? now : null;
    this.#sql`
      UPDATE cf_agents_workflows
      SET status = ${status.status},
          error_name = ${status.error?.name ?? null},
          error_message = ${status.error?.message ?? null},
          updated_at = ${now},
          completed_at = ${completedAt}
      WHERE workflow_id = ${workflowId}
    `;
  }

  #requireTracked(workflowId: string): WorkflowInfo {
    const info = this.get(workflowId);
    if (!info) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }
    return info;
  }

  // ── Bindings and origin ──────────────────────────────────────────────────

  #binding(name: string): Workflow | undefined {
    const binding = (this.#options.env as Record<string, unknown>)[name];
    return isWorkflowBinding(binding) ? binding : undefined;
  }

  #requireBinding(name: string): Workflow {
    const binding = this.#binding(name);
    if (!binding) {
      throw new Error(`Workflow binding '${name}' not found in environment`);
    }
    return binding;
  }

  #bindingNames(): string[] {
    return Object.entries(this.#options.env as Record<string, unknown>)
      .filter(([, value]) => isWorkflowBinding(value))
      .map(([key]) => key);
  }

  /** Where callbacks route back to: the agent, or a facet below its root. */
  #origin(
    owner: WorkflowOwner,
    agentBinding: string | undefined
  ): AgentWorkflowOrigin | undefined {
    if (owner.kind === "facet") {
      const root = owner.path[0];
      const rootBinding =
        agentBinding ??
        (root ? this.#agentBindingFor(root.className) : undefined);
      if (!rootBinding) return undefined;
      return {
        kind: "facet",
        version: 1,
        rootBinding,
        path: owner.path.map((step) => ({ ...step }))
      };
    }
    const binding = agentBinding ?? this.#agentBindingFor(owner.className);
    if (!binding) return undefined;
    return { kind: "agent", version: 1, binding, name: owner.name };
  }

  /** The namespace binding whose name matches a class name. */
  #agentBindingFor(className: string): string | undefined {
    for (const [key, value] of Object.entries(
      this.#options.env as Record<string, unknown>
    )) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function" &&
        (key === className ||
          camelCaseToKebabCase(key) === camelCaseToKebabCase(className))
      ) {
        return key;
      }
    }
    return undefined;
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #ensureTable(): void {
    if (this.#tableReady) return;
    const storage = this.lifecycle.storage;
    if (
      (storage.kv.get<number>(SCHEMA_VERSION_KEY) ?? 0) < CURRENT_SCHEMA_VERSION
    ) {
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS cf_agents_workflows (
          id TEXT PRIMARY KEY NOT NULL,
          workflow_id TEXT NOT NULL UNIQUE,
          workflow_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'queued', 'running', 'paused', 'errored',
            'terminated', 'complete', 'waiting',
            'waitingForPause', 'unknown'
          )),
          metadata TEXT,
          error_name TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          completed_at INTEGER
        )
      `);
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_workflows_status ON cf_agents_workflows(status)"
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_workflows_name ON cf_agents_workflows(workflow_name)"
      );
      storage.kv.put(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
    }
    this.#tableReady = true;
  }

  #query<T>(query: string, params: SqlValue[]): T[] {
    this.#ensureTable();
    try {
      return [...this.lifecycle.storage.sql.exec(query, ...params)] as T[];
    } catch (error) {
      throw new SqlError(query, error);
    }
  }

  /** Run a write and return the rows it changed. */
  #write(query: string, params: SqlValue[]): number {
    this.#ensureTable();
    try {
      return this.lifecycle.storage.sql.exec(query, ...params).rowsWritten;
    } catch (error) {
      throw new SqlError(query, error);
    }
  }

  #sql<T = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    return this.#query<T>(strings.join("?"), values);
  }

  #emit(type: string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
