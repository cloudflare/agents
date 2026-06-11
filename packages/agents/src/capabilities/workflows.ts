/**
 * Workflows capability (Layer 1). Owns the `cf_agents_workflows`
 * tracking table.
 *
 * The `Agent` class delegates its `runWorkflow()`/`getWorkflow*()`/
 * workflow-control methods plus the `_workflow_*` RPC entry points
 * here; the capability talks to the agent only through the narrow
 * {@link WorkflowsHost} slice. Calls to *public* agent methods (e.g.
 * `getWorkflow`, `sendWorkflowEvent`, the `onWorkflow*` lifecycle
 * hooks, `setState`, `broadcast`) are re-dispatched through the agent
 * instance so subclass overrides keep working exactly as before.
 */

import { nanoid } from "nanoid";
import { isErrorRetryable, tryN } from "../retries";
import { camelCaseToKebabCase } from "../utils";
import type { SqlHost } from "../core/host";
// `Workflow`, `InstanceStatus`, `SqlStorage` are ambient globals from
// @cloudflare/workers-types.
import type {
  RunWorkflowOptions,
  WorkflowCallback,
  WorkflowEventPayload,
  WorkflowInfo,
  WorkflowPage,
  WorkflowQueryCriteria,
  WorkflowStatus,
  WorkflowTrackingRow
} from "../workflow-types";

type WorkflowEventType =
  | "workflow:start"
  | "workflow:event"
  | "workflow:approved"
  | "workflow:rejected"
  | "workflow:terminated"
  | "workflow:paused"
  | "workflow:resumed"
  | "workflow:restarted";

/**
 * The public Agent surface the capability re-dispatches through so
 * subclass overrides are honored (these methods are all overridable).
 */
interface WorkflowAgentSurface {
  getWorkflow(workflowId: string): WorkflowInfo | undefined;
  sendWorkflowEvent(
    workflowName: string,
    workflowId: string,
    event: WorkflowEventPayload
  ): Promise<void>;
  onWorkflowCallback(callback: WorkflowCallback): Promise<void>;
  onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void>;
  onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void>;
  onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void>;
  onWorkflowEvent(
    workflowName: string,
    workflowId: string,
    event: unknown
  ): Promise<void>;
  broadcast(msg: string): void;
  setState(state: unknown): void;
  state: unknown;
  initialState: unknown;
}

/** The slice of the agent the workflows capability needs. */
export interface WorkflowsHost {
  /**
   * The agent instance — public workflow methods and lifecycle hooks
   * are re-dispatched through it so subclass overrides are honored.
   */
  agent: object;
  sql: SqlHost["sql"];
  /**
   * Positional-parameter SQL (`ctx.storage.sql.exec`) for
   * dynamically-built queries.
   */
  rawSql: SqlStorage["exec"];
  emit(type: WorkflowEventType, payload: Record<string, unknown>): void;
  /** The agent's env, for Workflow / Agent namespace binding lookup. */
  env(): Record<string, unknown>;
  /** The agent's instance name (injected into workflow params). */
  agentInstanceName(): string;
  /** The agent's class name (used to auto-detect the Agent binding). */
  agentClassName(): string;
  /** `__unsafe_ensureInitialized` — awaited by the RPC entry points. */
  ensureInitialized(): Promise<void>;
}

export class AgentWorkflows {
  private readonly _host: WorkflowsHost;

  constructor(host: WorkflowsHost) {
    this._host = host;
  }

  private get _agent(): WorkflowAgentSurface {
    return this._host.agent as WorkflowAgentSurface;
  }

  /**
   * Start a workflow and track it in the Agent's database.
   * Automatically injects agent identity into the workflow params.
   * @returns The workflow instance ID
   */
  async run(
    workflowName: string,
    params: unknown,
    options?: RunWorkflowOptions
  ): Promise<string> {
    // Look up the workflow binding by name
    const workflow = this._findWorkflowBindingByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowName}' not found in environment`
      );
    }

    // Find the binding name for this Agent's namespace
    const agentBindingName =
      options?.agentBinding ?? this._findAgentBindingName();
    if (!agentBindingName) {
      throw new Error(
        "Could not detect Agent binding name from class name. " +
          "Pass it explicitly via options.agentBinding"
      );
    }

    // Workflows instance IDs must start with [a-zA-Z0-9_].
    const workflowId = options?.id ?? `wf_${nanoid()}`;

    // Inject agent identity and workflow name into params
    const augmentedParams = {
      ...(params as Record<string, unknown>),
      __agentName: this._host.agentInstanceName(),
      __agentBinding: agentBindingName,
      __workflowName: workflowName
    };

    // Create the workflow instance
    const instance = await workflow.create({
      id: workflowId,
      params: augmentedParams
    });

    // Track the workflow in our database
    const id = nanoid();
    const metadataJson = options?.metadata
      ? JSON.stringify(options.metadata)
      : null;
    try {
      this._host.sql`
        INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status, metadata)
        VALUES (${id}, ${instance.id}, ${workflowName}, 'queued', ${metadataJson})
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

    this._host.emit("workflow:start", {
      workflowId: instance.id,
      workflowName
    });

    return instance.id;
  }

  /**
   * Send an event to a running workflow.
   * The workflow can wait for this event using step.waitForEvent().
   */
  async sendEvent(
    workflowName: string,
    workflowId: string,
    event: WorkflowEventPayload
  ): Promise<void> {
    const workflow = this._findWorkflowBindingByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    await tryN(3, async () => instance.sendEvent(event), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    this._host.emit("workflow:event", { workflowId, eventType: event.type });
  }

  /**
   * Approve a waiting workflow by sending it an approval event.
   */
  async approve(
    workflowId: string,
    data?: { reason?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const workflowInfo = this._agent.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    await this._agent.sendWorkflowEvent(workflowInfo.workflowName, workflowId, {
      type: "approval",
      payload: {
        approved: true,
        reason: data?.reason,
        metadata: data?.metadata
      }
    });

    this._host.emit("workflow:approved", { workflowId, reason: data?.reason });
  }

  /**
   * Reject a waiting workflow by sending it a rejection event.
   */
  async reject(workflowId: string, data?: { reason?: string }): Promise<void> {
    const workflowInfo = this._agent.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    await this._agent.sendWorkflowEvent(workflowInfo.workflowName, workflowId, {
      type: "approval",
      payload: {
        approved: false,
        reason: data?.reason
      }
    });

    this._host.emit("workflow:rejected", { workflowId, reason: data?.reason });
  }

  /**
   * Terminate a running workflow.
   */
  async terminate(workflowId: string): Promise<void> {
    const workflowInfo = this._agent.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(workflowInfo.workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    await tryN(3, async () => instance.terminate(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    // Update tracking table with new status
    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this._host.emit("workflow:terminated", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
  }

  /**
   * Pause a running workflow.
   */
  async pause(workflowId: string): Promise<void> {
    const workflowInfo = this._agent.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(workflowInfo.workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    await tryN(3, async () => instance.pause(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this._host.emit("workflow:paused", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
  }

  /**
   * Resume a paused workflow.
   */
  async resume(workflowId: string): Promise<void> {
    const workflowInfo = this._agent.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(workflowInfo.workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    await tryN(3, async () => instance.resume(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    const status = await instance.status();
    this._updateWorkflowTracking(workflowId, status);

    this._host.emit("workflow:resumed", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
  }

  /**
   * Restart a workflow instance from the beginning with the same ID.
   */
  async restart(
    workflowId: string,
    options: { resetTracking?: boolean } = {}
  ): Promise<void> {
    const { resetTracking = true } = options;

    const workflowInfo = this._agent.getWorkflow(workflowId);
    if (!workflowInfo) {
      throw new Error(`Workflow ${workflowId} not found in tracking table`);
    }

    const workflow = this._findWorkflowBindingByName(workflowInfo.workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowInfo.workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    await tryN(3, async () => instance.restart(), {
      shouldRetry: isErrorRetryable,
      baseDelayMs: 200,
      maxDelayMs: 3000
    });

    if (resetTracking) {
      // Reset tracking fields for fresh start
      const now = Math.floor(Date.now() / 1000);
      this._host.sql`
        UPDATE cf_agents_workflows
        SET status = 'queued',
            created_at = ${now},
            updated_at = ${now},
            completed_at = NULL,
            error_name = NULL,
            error_message = NULL
        WHERE workflow_id = ${workflowId}
      `;
    } else {
      // Just update status from Cloudflare
      const status = await instance.status();
      this._updateWorkflowTracking(workflowId, status);
    }

    this._host.emit("workflow:restarted", {
      workflowId,
      workflowName: workflowInfo.workflowName
    });
  }

  /**
   * Get the status of a workflow and update the tracking record.
   */
  async getStatus(
    workflowName: string,
    workflowId: string
  ): Promise<InstanceStatus> {
    const workflow = this._findWorkflowBindingByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow binding '${workflowName}' not found in environment`
      );
    }

    const instance = await workflow.get(workflowId);
    const status = await instance.status();

    // Update the tracking record
    this._updateWorkflowTracking(workflowId, status);

    return status;
  }

  /**
   * Get a tracked workflow by ID, or undefined if not found.
   */
  get(workflowId: string): WorkflowInfo | undefined {
    const rows = this._host.sql<WorkflowTrackingRow>`
      SELECT * FROM cf_agents_workflows WHERE workflow_id = ${workflowId}
    `;

    if (!rows || rows.length === 0) {
      return undefined;
    }

    return this._rowToWorkflowInfo(rows[0]);
  }

  /**
   * Query tracked workflows with cursor-based pagination.
   */
  getPage(criteria: WorkflowQueryCriteria = {}): WorkflowPage {
    const limit = Math.min(criteria.limit ?? 50, 100);
    const isAsc = criteria.orderBy === "asc";

    // Get total count (ignores cursor and limit)
    const total = this._countWorkflows(criteria);

    // Build base query
    let query = "SELECT * FROM cf_agents_workflows WHERE 1=1";
    const params: (string | number | boolean)[] = [];

    if (criteria.status) {
      const statuses = Array.isArray(criteria.status)
        ? criteria.status
        : [criteria.status];
      const placeholders = statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }

    if (criteria.workflowName) {
      query += " AND workflow_name = ?";
      params.push(criteria.workflowName);
    }

    if (criteria.metadata) {
      for (const [key, value] of Object.entries(criteria.metadata)) {
        query += ` AND json_extract(metadata, '$.' || ?) = ?`;
        params.push(key, value);
      }
    }

    // Apply cursor for keyset pagination
    if (criteria.cursor) {
      const cursor = this._decodeCursor(criteria.cursor);
      if (isAsc) {
        // ASC: get items after cursor
        query +=
          " AND (created_at > ? OR (created_at = ? AND workflow_id > ?))";
      } else {
        // DESC: get items before cursor
        query +=
          " AND (created_at < ? OR (created_at = ? AND workflow_id < ?))";
      }
      params.push(cursor.createdAt, cursor.createdAt, cursor.workflowId);
    }

    // Order by created_at and workflow_id for consistent keyset pagination
    query += ` ORDER BY created_at ${isAsc ? "ASC" : "DESC"}, workflow_id ${isAsc ? "ASC" : "DESC"}`;

    // Fetch limit + 1 to detect if there are more pages
    query += " LIMIT ?";
    params.push(limit + 1);

    const rows = this._host
      .rawSql(query, ...params)
      .toArray() as WorkflowTrackingRow[];

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    const workflows = resultRows.map((row) => this._rowToWorkflowInfo(row));

    // Build next cursor from last item
    const nextCursor =
      hasMore && workflows.length > 0
        ? this._encodeCursor(workflows[workflows.length - 1])
        : null;

    return { workflows, total, nextCursor };
  }

  /**
   * Delete a workflow tracking record.
   * @returns true if a record was deleted, false if not found
   */
  delete(workflowId: string): boolean {
    // First check if workflow exists
    const existing = this._host.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_workflows WHERE workflow_id = ${workflowId}
    `;
    if (!existing[0] || existing[0].count === 0) {
      return false;
    }
    this._host
      .sql`DELETE FROM cf_agents_workflows WHERE workflow_id = ${workflowId}`;
    return true;
  }

  /**
   * Delete workflow tracking records matching criteria.
   * @returns Number of records matching criteria (expected deleted count)
   */
  deleteMany(
    criteria: Omit<WorkflowQueryCriteria, "limit" | "orderBy"> & {
      createdBefore?: Date;
    } = {}
  ): number {
    let query = "DELETE FROM cf_agents_workflows WHERE 1=1";
    const params: (string | number | boolean)[] = [];

    if (criteria.status) {
      const statuses = Array.isArray(criteria.status)
        ? criteria.status
        : [criteria.status];
      const placeholders = statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }

    if (criteria.workflowName) {
      query += " AND workflow_name = ?";
      params.push(criteria.workflowName);
    }

    if (criteria.metadata) {
      for (const [key, value] of Object.entries(criteria.metadata)) {
        query += ` AND json_extract(metadata, '$.' || ?) = ?`;
        params.push(key, value);
      }
    }

    if (criteria.createdBefore) {
      query += " AND created_at < ?";
      params.push(Math.floor(criteria.createdBefore.getTime() / 1000));
    }

    const cursor = this._host.rawSql(query, ...params);
    return cursor.rowsWritten;
  }

  /**
   * Migrate workflow tracking records from an old binding name to a
   * new one.
   * @returns Number of records migrated
   */
  migrateBinding(oldName: string, newName: string): number {
    // Validate new binding exists
    if (!this._findWorkflowBindingByName(newName)) {
      throw new Error(`Workflow binding '${newName}' not found in environment`);
    }

    const result = this._host.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_workflows WHERE workflow_name = ${oldName}
    `;
    const count = result[0]?.count ?? 0;

    if (count > 0) {
      this._host
        .sql`UPDATE cf_agents_workflows SET workflow_name = ${newName} WHERE workflow_name = ${oldName}`;
      console.log(
        `[Agent] Migrated ${count} workflow(s) from '${oldName}' to '${newName}'`
      );
    }

    return count;
  }

  /**
   * Check for workflows referencing unknown bindings and warn with a
   * migration suggestion.
   */
  checkOrphaned(): void {
    // Get distinct workflow names with counts by active/completed status
    const distinctNames = this._host.sql<{
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

    const orphaned = distinctNames.filter(
      (row) => !this._findWorkflowBindingByName(row.workflow_name)
    );

    if (orphaned.length > 0) {
      const currentBindings = this._getWorkflowBindingNames();
      for (const {
        workflow_name: oldName,
        total,
        active,
        completed
      } of orphaned) {
        const suggestion =
          currentBindings.length === 1
            ? `this.migrateWorkflowBinding('${oldName}', '${currentBindings[0]}')`
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
  }

  /**
   * Handle a callback from a workflow: update the tracking table and
   * dispatch to the agent's `onWorkflow*` lifecycle hooks.
   */
  async handleCallback(callback: WorkflowCallback): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    switch (callback.type) {
      case "progress":
        // Update tracking status to "running" when receiving progress
        // Only transition from queued/waiting to avoid overwriting terminal states
        this._host.sql`
          UPDATE cf_agents_workflows
          SET status = 'running', updated_at = ${now}
          WHERE workflow_id = ${callback.workflowId} AND status IN ('queued', 'waiting')
        `;
        await this._agent.onWorkflowProgress(
          callback.workflowName,
          callback.workflowId,
          callback.progress
        );
        break;
      case "complete":
        // Update tracking status to "complete"
        // Don't overwrite if already terminated/paused (race condition protection)
        this._host.sql`
          UPDATE cf_agents_workflows
          SET status = 'complete', updated_at = ${now}, completed_at = ${now}
          WHERE workflow_id = ${callback.workflowId}
            AND status NOT IN ('terminated', 'paused')
        `;
        await this._agent.onWorkflowComplete(
          callback.workflowName,
          callback.workflowId,
          callback.result
        );
        break;
      case "error":
        // Update tracking status to "errored"
        // Don't overwrite if already terminated/paused (race condition protection)
        this._host.sql`
          UPDATE cf_agents_workflows
          SET status = 'errored', updated_at = ${now}, completed_at = ${now},
              error_name = 'WorkflowError', error_message = ${callback.error}
          WHERE workflow_id = ${callback.workflowId}
            AND status NOT IN ('terminated', 'paused')
        `;
        await this._agent.onWorkflowError(
          callback.workflowName,
          callback.workflowId,
          callback.error
        );
        break;
      case "event":
        // No status change for events - they can occur at any stage
        await this._agent.onWorkflowEvent(
          callback.workflowName,
          callback.workflowId,
          callback.event
        );
        break;
    }
  }

  /**
   * `_workflow_handleCallback` RPC entry point body.
   */
  async rpcHandleCallback(callback: WorkflowCallback): Promise<void> {
    await this._host.ensureInitialized();
    await this._agent.onWorkflowCallback(callback);
  }

  /**
   * `_workflow_broadcast` RPC entry point body.
   */
  async rpcBroadcast(message: unknown): Promise<void> {
    await this._host.ensureInitialized();
    this._agent.broadcast(JSON.stringify(message));
  }

  /**
   * `_workflow_updateState` RPC entry point body.
   */
  async rpcUpdateState(
    action: "set" | "merge" | "reset",
    state?: unknown
  ): Promise<void> {
    await this._host.ensureInitialized();
    if (action === "set") {
      this._agent.setState(state);
    } else if (action === "merge") {
      const currentState = this._agent.state ?? {};
      this._agent.setState({
        ...(currentState as Record<string, unknown>),
        ...(state as Record<string, unknown>)
      });
    } else if (action === "reset") {
      this._agent.setState(this._agent.initialState);
    }
  }

  /**
   * Find a workflow binding by its name.
   */
  private _findWorkflowBindingByName(
    workflowName: string
  ): Workflow | undefined {
    const binding = this._host.env()[workflowName];
    if (
      binding &&
      typeof binding === "object" &&
      "create" in binding &&
      "get" in binding
    ) {
      return binding as Workflow;
    }
    return undefined;
  }

  /**
   * Get all workflow binding names from the environment.
   */
  private _getWorkflowBindingNames(): string[] {
    const names: string[] = [];
    for (const [key, value] of Object.entries(this._host.env())) {
      if (
        value &&
        typeof value === "object" &&
        "create" in value &&
        "get" in value
      ) {
        names.push(key);
      }
    }
    return names;
  }

  /**
   * Find the binding name for this Agent's namespace by matching class name.
   * Returns undefined if no match found - use options.agentBinding as fallback.
   */
  private _findAgentBindingName(): string | undefined {
    const className = this._host.agentClassName();
    for (const [key, value] of Object.entries(this._host.env())) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function"
      ) {
        // Check if this namespace's binding name matches our class name
        if (
          key === className ||
          camelCaseToKebabCase(key) === camelCaseToKebabCase(className)
        ) {
          return key;
        }
      }
    }
    return undefined;
  }

  /**
   * Count workflows matching criteria (for pagination total).
   */
  private _countWorkflows(
    criteria: Omit<WorkflowQueryCriteria, "limit" | "cursor" | "orderBy"> & {
      createdBefore?: Date;
    }
  ): number {
    let query = "SELECT COUNT(*) as count FROM cf_agents_workflows WHERE 1=1";
    const params: (string | number | boolean)[] = [];

    if (criteria.status) {
      const statuses = Array.isArray(criteria.status)
        ? criteria.status
        : [criteria.status];
      const placeholders = statuses.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...statuses);
    }

    if (criteria.workflowName) {
      query += " AND workflow_name = ?";
      params.push(criteria.workflowName);
    }

    if (criteria.metadata) {
      for (const [key, value] of Object.entries(criteria.metadata)) {
        query += ` AND json_extract(metadata, '$.' || ?) = ?`;
        params.push(key, value);
      }
    }

    if (criteria.createdBefore) {
      query += " AND created_at < ?";
      params.push(Math.floor(criteria.createdBefore.getTime() / 1000));
    }

    const result = this._host.rawSql(query, ...params).toArray() as {
      count: number;
    }[];

    return result[0]?.count ?? 0;
  }

  /**
   * Encode a cursor from workflow info for pagination.
   * Stores createdAt as Unix timestamp in seconds (matching DB storage).
   */
  private _encodeCursor(workflow: WorkflowInfo): string {
    return btoa(
      JSON.stringify({
        c: Math.floor(workflow.createdAt.getTime() / 1000),
        i: workflow.workflowId
      })
    );
  }

  /**
   * Decode a pagination cursor.
   * Returns createdAt as Unix timestamp in seconds (matching DB storage).
   */
  private _decodeCursor(cursor: string): {
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

  /**
   * Update workflow tracking record from InstanceStatus
   */
  private _updateWorkflowTracking(
    workflowId: string,
    status: InstanceStatus
  ): void {
    const statusName = status.status;
    const now = Math.floor(Date.now() / 1000);

    // Determine if workflow is complete
    const completedStatuses: WorkflowStatus[] = [
      "complete",
      "errored",
      "terminated"
    ];
    const completedAt = completedStatuses.includes(statusName) ? now : null;

    // Extract error info if present
    const errorName = status.error?.name ?? null;
    const errorMessage = status.error?.message ?? null;

    this._host.sql`
      UPDATE cf_agents_workflows
      SET status = ${statusName},
          error_name = ${errorName},
          error_message = ${errorMessage},
          updated_at = ${now},
          completed_at = ${completedAt}
      WHERE workflow_id = ${workflowId}
    `;
  }

  /**
   * Convert a database row to WorkflowInfo
   */
  private _rowToWorkflowInfo(row: WorkflowTrackingRow): WorkflowInfo {
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
}
