import {
  Artifact,
  StreamResponse,
  Role,
  Task,
  TaskState,
  type ListTasksRequest,
  ListTasksResponse,
  Message
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import {
  A2AError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError
} from "@a2a-js/sdk/errors";
import { canonicalJson } from "./canonical-json";
import { workflowInstanceId } from "./ids";
import {
  SERVER_MESSAGE_ID_PREFIX,
  agentMessage,
  conversationHistory,
  messageFingerprint
} from "./messages";
import {
  assertJsonCompatible,
  assertJsonObject,
  parseLosslessJson,
  prepareArtifactJsonForSdk,
  prepareMessageJsonForSdk,
  prepareTaskJsonForSdk,
  restoreArtifactDataNull,
  restoreMessageDataNull,
  restoreTaskDataNull,
  validateArtifactValues,
  validateArtifactValue,
  validateTaskJson
} from "./json-validation";
import type { A2AWorkflowParams, CurrentA2AWorkflowParams } from "./types";

export interface RecoveryAlarm {
  getAlarm(): number | null | Promise<number | null>;
  setAlarm(scheduledTime: number): void | Promise<void>;
}

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED
]);
const EVENT_REPLAY_STOP_STATES = [
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED
] as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const LIST_TASK_SIZE_PLACEHOLDER = Task.fromJSON({});
const LIST_TASK_SIZE_PLACEHOLDER_BYTES = textEncoder.encode(
  JSON.stringify(Task.toJSON(LIST_TASK_SIZE_PLACEHOLDER))
).byteLength;
/** Caps the fully assembled Task while leaving headroom for serialized responses. */
export const MAX_SERIALIZED_TASK_BYTES = 1_900_000;
export const MAX_WORKFLOW_TERMINAL_REASON_BYTES = 512;
const ACTIVE_TASK_TERMINAL_RESERVE_BYTES = 8 * 1024;
const MAX_INTERMEDIATE_ARTIFACT_BYTES = 256 * 1024;
const MAX_INTERMEDIATE_ARTIFACT_PUBLICATIONS = 256;
const MAX_ARTIFACT_PUBLICATION_ID_BYTES = 256;
const MAX_WORKFLOW_EVENT_PAYLOAD_BYTES = 1024 * 1024;
const RECOVERY_BATCH_SIZE = 8;
export const LEGACY_MIGRATION_BATCH_SIZE = 4;
export const MAX_EVENTS_PER_BATCH = 32;
export const MAX_EVENT_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_LIST_RESPONSE_BYTES = 2 * 1024 * 1024;
const EVENT_SQL_BATCH_SIZE = 4;
const LIST_SQL_BATCH_SIZE = 4;
const LIST_RESPONSE_ENVELOPE_RESERVE_BYTES = 4 * 1024;
const EVENT_COMPACTION_BATCH_SIZE = 64;
export const EVENT_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const TERMINAL_TASK_COMPACTION_BATCH_SIZE = 64;
export const DEFAULT_TERMINAL_TASK_RETENTION_MILLISECONDS =
  30 * 24 * 60 * 60 * 1_000;
const LEGACY_TASK_PENDING = 0;
const LEGACY_TASK_NORMALIZED = 1;
const LEGACY_TASK_QUARANTINED = -1;
const MAX_LEGACY_QUARANTINE_ERROR_BYTES = 512;
const ARTIFACT_PUBLICATION_SCHEMA_MIGRATION = "artifact-publication-identity";
const ARTIFACT_PUBLICATION_SCHEMA_VERSION = 1;

interface TaskRow {
  [key: string]: SqlStorageValue;
  context_id: string;
  created_at: number;
  data: string;
  id: string;
  normalized: number;
  owner: string;
  state: number;
  status_timestamp: string | null;
  turn: number;
  updated_at: number;
  workflow_instance_id: string;
}

interface TaskChildRow {
  [key: string]: SqlStorageValue;
  data: string;
  position: number;
}

interface SerializedTaskParts {
  artifactRows: Array<{ artifactId: string; data: string }>;
  baseData: string;
  historyRows: string[];
}

export interface WorkflowAgentIdentity {
  agentBinding: string;
  agentName: string;
  workflowName: string;
}

interface MessageRow {
  [key: string]: SqlStorageValue;
  context_id: string;
  fingerprint: string;
  task_id: string;
}

interface ArtifactPublicationRow {
  [key: string]: SqlStorageValue;
  fingerprint: string;
  publication_id: string;
  task_id: string;
  turn: number;
}

interface EventRow {
  [key: string]: SqlStorageValue;
  data: string;
  sequence: number;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface CancellationRow {
  [key: string]: SqlStorageValue;
  params: string | null;
  requested_at: number;
  task_id: string;
  turn: number;
  workflow_instance_id: string;
}

interface CancellationHookRow {
  [key: string]: SqlStorageValue;
  data: string;
  task_id: string;
}

export interface PendingCancellationHook {
  task: Task;
  taskId: string;
}

export interface AcceptedTask {
  params: CurrentA2AWorkflowParams;
  shouldStart: boolean;
  task: Task;
  workflowInstanceId: string;
}

export interface TaskStreamSnapshot {
  sequence: number;
  task: Task;
}

export interface DurableTaskEvent {
  sequence: number;
  response: StreamResponse;
}

export interface EventWaiter {
  cancel(): void;
  promise: Promise<void>;
}

export interface PendingLaunch {
  params: CurrentA2AWorkflowParams;
  workflowInstanceId: string;
}

export interface TaskReadOptions {
  historyLength?: number;
  includeArtifacts?: boolean;
}

export interface WorkflowReconciliationTarget {
  taskId: string;
  turn: number;
  workflowInstanceId: string;
}

export type WorkflowTerminalStatus =
  | "complete"
  | "errored"
  | "missing"
  | "terminated";

export interface CancellationTarget {
  allowMissing: boolean;
  params?: A2AWorkflowParams;
  taskId: string;
  turn: number;
  workflowInstanceId: string;
}

export type CancellationPreparation =
  | { status: "canceled"; task: Task }
  | { status: "pending"; target: CancellationTarget };

export interface CancellationCompletion {
  newlyCanceled: boolean;
  task: Task;
}

type CancellationPreparationInternal =
  | CancellationPreparation
  | {
      status: "terminal";
      task: Task;
    };

type CancellationFinalization =
  | { status: "canceled"; completion: CancellationCompletion }
  | { status: "stale" }
  | { status: "terminal"; task: Task };

export type MetadataAppendResult =
  | { status: "appended" | "duplicate"; task: Task }
  | { status: "canceled"; task: Task };

/** Defines the durable task, event, idempotency, and recovery operations used by the handler. */
export interface A2ATaskRepository extends TaskStore {
  load(
    taskId: string,
    context: ServerCallContext,
    options?: TaskReadOptions
  ): Promise<Task | undefined>;
  acceptInitial(
    taskId: string,
    contextId: string,
    message: Message,
    fingerprint: string,
    context: ServerCallContext
  ): AcceptedTask;
  acceptContinuation(
    taskId: string,
    message: Message,
    fingerprint: string,
    context: ServerCallContext
  ): AcceptedTask;
  beginCancellation(
    taskId: string,
    context: ServerCallContext
  ): CancellationPreparation;
  cancelAfterTermination(
    taskId: string,
    target: CancellationTarget,
    context: ServerCallContext
  ): CancellationCompletion | undefined;
  appendMetadataItem(
    taskId: string,
    key: string,
    item: unknown,
    turn: number
  ): MetadataAppendResult;
  acknowledgeCancellationHook(taskId: string): void;
  armRecovery(delayMilliseconds?: number, replace?: boolean): Promise<void>;
  eventsAfter(taskId: string, sequence: number): DurableTaskEvent[];
  markWorking(taskId: string, turn: number): void;
  pendingLaunches(): PendingLaunch[];
  streamSnapshot(
    taskId: string,
    context: ServerCallContext,
    historyLength?: number
  ): Promise<TaskStreamSnapshot>;
  waitForUpdate(taskId: string, signal?: AbortSignal): EventWaiter;
  isInterruptedOrTerminal(taskId: string): boolean;
}

/**
 * Stores one owner's shard of tasks and stream events in SQLite, while keeping
 * Workflow callbacks, retries, and cancellation safe across turns.
 */
export class DurableObjectTaskStore implements A2ATaskRepository {
  private readonly sql: SqlStorage;
  private readonly waiters = new Map<string, Set<() => void>>();

  /** Creates the task tables and applies small idempotent schema migrations. */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly workflowAgentIdentity: WorkflowAgentIdentity,
    private readonly durableEvents = false,
    private readonly durableCancellationHook = false,
    private readonly recoveryAlarm: RecoveryAlarm = storage,
    private readonly terminalTaskRetentionMilliseconds = DEFAULT_TERMINAL_TASK_RETENTION_MILLISECONDS
  ) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS a2a_tasks (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        workflow_instance_id TEXT NOT NULL,
        turn INTEGER NOT NULL DEFAULT 1,
        state INTEGER NOT NULL,
        status_timestamp TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        normalized INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS a2a_tasks_context_updated
        ON a2a_tasks(context_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_owner_updated
        ON a2a_tasks(owner, updated_at DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_context_created
        ON a2a_tasks(context_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_owner_created
        ON a2a_tasks(owner, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_owner_status
        ON a2a_tasks(owner, COALESCE(status_timestamp, '') DESC, id DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_context_status
        ON a2a_tasks(context_id, COALESCE(status_timestamp, '') DESC, id DESC);
      CREATE INDEX IF NOT EXISTS a2a_tasks_state_id
        ON a2a_tasks(state, id);
      CREATE INDEX IF NOT EXISTS a2a_tasks_updated_state_id
        ON a2a_tasks(updated_at, state, id);
      CREATE TABLE IF NOT EXISTS a2a_task_history (
        task_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (task_id, position)
      );
      CREATE TABLE IF NOT EXISTS a2a_task_artifacts (
        task_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        artifact_id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (task_id, position)
      );
      CREATE INDEX IF NOT EXISTS a2a_task_artifacts_id
        ON a2a_task_artifacts(task_id, artifact_id);
      CREATE TABLE IF NOT EXISTS a2a_message_ids (
        context_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (context_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS a2a_message_ids_task
        ON a2a_message_ids(task_id);
      CREATE TABLE IF NOT EXISTS a2a_task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS a2a_task_events_task_sequence
        ON a2a_task_events(task_id, sequence);
      CREATE TABLE IF NOT EXISTS a2a_artifact_publications (
        publication_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, turn, publication_id)
      );
      CREATE INDEX IF NOT EXISTS a2a_artifact_publications_task
        ON a2a_artifact_publications(task_id);
      CREATE TABLE IF NOT EXISTS a2a_cancellation_intents (
        task_id TEXT PRIMARY KEY,
        workflow_instance_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        params TEXT,
        requested_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a2a_cancellation_hooks (
        task_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a2a_cancellation_hook_dead_letters (
        task_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        failed_at INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a2a_legacy_quarantine (
        task_id TEXT PRIMARY KEY,
        error TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a2a_quarantined_message_ids (
        context_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (context_id, message_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS a2a_quarantined_message_ids_message
        ON a2a_quarantined_message_ids(context_id, message_id);
      CREATE TABLE IF NOT EXISTS a2a_recovery_cursors (
        kind TEXT PRIMARY KEY,
        task_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a2a_schema_metadata (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
    `);
    const columns = this.sql
      .exec<{ name: string }>("PRAGMA table_info(a2a_tasks)")
      .toArray();
    if (!columns.some((column) => column.name === "turn")) {
      this.sql.exec(
        "ALTER TABLE a2a_tasks ADD COLUMN turn INTEGER NOT NULL DEFAULT 1"
      );
    }
    if (!columns.some((column) => column.name === "normalized")) {
      this.sql.exec(
        "ALTER TABLE a2a_tasks ADD COLUMN normalized INTEGER NOT NULL DEFAULT 0"
      );
    }
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS a2a_tasks_normalized_id
       ON a2a_tasks(normalized, id)`
    );
    this.migrateArtifactPublicationIdentity();
  }

  /** Scopes publication IDs without losing rows written by the legacy schema. */
  private migrateArtifactPublicationIdentity(): void {
    this.storage.transactionSync(() => {
      const version = this.sql
        .exec<{ version: number }>(
          "SELECT version FROM a2a_schema_metadata WHERE name = ?",
          ARTIFACT_PUBLICATION_SCHEMA_MIGRATION
        )
        .toArray()[0]?.version;
      const primaryKey = this.sql
        .exec<{ name: string; pk: number }>(
          "PRAGMA table_info(a2a_artifact_publications)"
        )
        .toArray()
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      const scoped =
        primaryKey.length === 3 &&
        primaryKey[0] === "task_id" &&
        primaryKey[1] === "turn" &&
        primaryKey[2] === "publication_id";
      if (
        !shouldRunSchemaMigration(
          version,
          ARTIFACT_PUBLICATION_SCHEMA_VERSION
        ) &&
        scoped
      )
        return;

      if (!scoped) {
        this.sql.exec(`
          DROP TABLE IF EXISTS a2a_artifact_publications_scoped;
          CREATE TABLE a2a_artifact_publications_scoped (
            publication_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            fingerprint TEXT NOT NULL,
            published_at INTEGER NOT NULL,
            PRIMARY KEY (task_id, turn, publication_id)
          );
          INSERT INTO a2a_artifact_publications_scoped (
            publication_id, task_id, turn, fingerprint, published_at
          ) SELECT publication_id, task_id, turn, fingerprint, published_at
            FROM a2a_artifact_publications;
          DROP TABLE a2a_artifact_publications;
          ALTER TABLE a2a_artifact_publications_scoped
            RENAME TO a2a_artifact_publications;
        `);
      }
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS a2a_artifact_publications_task
         ON a2a_artifact_publications(task_id)`
      );
      this.sql.exec(
        `INSERT INTO a2a_schema_metadata (name, version) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET version = MAX(version, excluded.version)`,
        ARTIFACT_PUBLICATION_SCHEMA_MIGRATION,
        ARTIFACT_PUBLICATION_SCHEMA_VERSION
      );
    });
  }

  /** Saves through the SDK path without changing task ownership or final state. */
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const owner = authenticatedOwner(context);
    this.prepareLegacyTaskForMutation(task.id, owner);
    this.storage.transactionSync(() => {
      const existing = this.taskRow(task.id);
      if (
        existing &&
        (existing.owner !== owner || existing.context_id !== task.contextId)
      ) {
        throw new A2AError("Task identity and context are immutable.");
      }
      if (existing && isTerminalState(existing.state)) return;
      if (!existing) {
        this.insertTask(task, owner, task.id, 1);
        return;
      }
      this.updateTask(task, existing.workflow_instance_id, existing.turn);
    });
  }

  /** Loads a task only when it belongs to the authenticated owner. */
  async load(
    taskId: string,
    context: ServerCallContext,
    options: TaskReadOptions = {}
  ): Promise<Task | undefined> {
    const row = this.taskRow(taskId, authenticatedOwner(context));
    if (!row) return undefined;
    if (row.normalized === LEGACY_TASK_PENDING) await this.armRecovery();
    const task = this.taskFromRow(row, options);
    return task;
  }

  /** Returns an owner-scoped, filterable, paginated list of tasks. */
  async list(
    params: ListTasksRequest,
    context: ServerCallContext
  ): Promise<ListTasksResponse> {
    const pageSize = params.pageSize ?? 50;
    const filterKey = taskListFilterKey(params);
    let cursor = decodePageToken(params.pageToken, filterKey);
    const where = ["owner = ?"];
    const values: (string | number)[] = [authenticatedOwner(context)];
    if (params.contextId) {
      where.push("context_id = ?");
      values.push(params.contextId);
    }
    if (params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      where.push("state = ?");
      values.push(params.status);
    }
    if (params.statusTimestampAfter) {
      where.push("status_timestamp >= ?");
      values.push(params.statusTimestampAfter);
    }

    const clause = where.join(" AND ");
    const totalSize = this.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count FROM a2a_tasks WHERE ${clause}`,
        ...values
      )
      .one().count;
    const tasks: Task[] = [];
    let serializedTasksBytes = 0;
    let hasMore = false;
    let sawPendingLegacy = false;

    listRows: while (true) {
      const batchWhere = [...where];
      const batchValues = [...values];
      if (cursor) {
        batchWhere.push(
          "(COALESCE(status_timestamp, '') < ? OR (COALESCE(status_timestamp, '') = ? AND id < ?))"
        );
        batchValues.push(
          cursor.statusTimestamp,
          cursor.statusTimestamp,
          cursor.id
        );
      }
      const remaining = pageSize - tasks.length;
      const limit =
        remaining === 0 ? 1 : Math.min(LIST_SQL_BATCH_SIZE, remaining);
      const rows = this.sql
        .exec<TaskRow>(
          `SELECT * FROM a2a_tasks
           WHERE ${batchWhere.join(" AND ")}
           ORDER BY COALESCE(status_timestamp, '') DESC, id DESC
           LIMIT ?`,
          ...batchValues,
          limit
        )
        .toArray();
      if (rows.length === 0) break;
      if (remaining === 0) {
        hasMore = true;
        break;
      }

      for (const row of rows) {
        if (row.normalized === LEGACY_TASK_PENDING && !sawPendingLegacy) {
          await this.armRecovery();
          sawPendingLegacy = true;
        }
        const task = this.taskFromRow(row, {
          historyLength: params.historyLength,
          includeArtifacts: params.includeArtifacts === true
        });
        const nextCursor = {
          id: row.id,
          statusTimestamp: row.status_timestamp ?? ""
        };
        const candidateToken = encodePageToken(nextCursor, filterKey);
        const taskBytes = serializedTaskByteLength(task);
        if (
          serializedListResponseByteLengthFromTaskBytes(
            serializedTasksBytes + taskBytes,
            tasks.length + 1,
            candidateToken,
            pageSize,
            totalSize
          ) > MAX_LIST_RESPONSE_BYTES
        ) {
          if (tasks.length === 0) {
            throw new Error(
              `Task ${row.id} exceeds the bounded ListTasks response budget.`
            );
          }
          hasMore = true;
          break listRows;
        }
        serializedTasksBytes += taskBytes;
        tasks.push(task);
        cursor = nextCursor;
      }
      if (rows.length < limit) break;
    }

    return {
      tasks,
      nextPageToken:
        hasMore && cursor ? encodePageToken(cursor, filterKey) : "",
      pageSize,
      totalSize
    };
  }

  /**
   * Atomically accepts an initial message, records its idempotency key, and
   * emits the first durable status event before Workflow creation begins.
   */
  acceptInitial(
    taskId: string,
    contextId: string,
    message: Message,
    fingerprint: string,
    context: ServerCallContext
  ): AcceptedTask {
    const owner = authenticatedOwner(context);
    this.prepareLegacyTaskForMutation(taskId, owner);
    this.prepareMessageAcceptance(contextId, message.messageId);
    return this.storage.transactionSync(() => {
      const replay = this.acceptedTask(
        contextId,
        message.messageId,
        fingerprint,
        owner
      );
      if (replay) return replay;

      const timestamp = new Date().toISOString();
      const workflowId = workflowInstanceId(taskId, 1);
      const task: Task = {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp
        },
        artifacts: [],
        history: [message],
        metadata: { workflowInstanceId: workflowId, turn: 1 }
      };
      const result = accepted(task, workflowId, 1, true);
      assertWorkflowPayloadSize(result.params, this.workflowAgentIdentity);
      this.insertTask(task, owner, workflowId, 1);
      this.appendStatusEvent(task);
      return result;
    });
  }

  /**
   * Starts a new turn from INPUT_REQUIRED with a fresh Workflow instance and
   * turn number; older callbacks carrying their original turn are ignored.
   */
  acceptContinuation(
    taskId: string,
    message: Message,
    fingerprint: string,
    context: ServerCallContext
  ): AcceptedTask {
    const owner = authenticatedOwner(context);
    this.prepareLegacyTaskForMutation(taskId, owner);
    this.prepareMessageAcceptance(message.contextId, message.messageId);
    const result = this.storage.transactionSync(() => {
      const replay = this.acceptedTask(
        message.contextId,
        message.messageId,
        fingerprint,
        owner
      );
      if (replay) return replay;

      const row = this.taskRow(taskId, owner);
      if (!row) throw new TaskNotFoundError(`Task not found: ${taskId}`);
      if (row.normalized === LEGACY_TASK_QUARANTINED) {
        throw new UnsupportedOperationError(
          `Task ${taskId} is quarantined and read-only.`
        );
      }
      const task = this.taskFromRow(row);
      if (task.contextId !== message.contextId) {
        throw new RequestMalformedError(
          "message.contextId does not match message.taskId."
        );
      }
      if (this.cancellationRow(taskId)) {
        throw new UnsupportedOperationError(
          `Task ${taskId} is being canceled and does not accept follow-up input.`
        );
      }
      if (task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
        throw new UnsupportedOperationError(
          `Task ${taskId} only accepts follow-up input while INPUT_REQUIRED.`
        );
      }

      const turn = row.turn + 1;
      const workflowId = workflowInstanceId(taskId, turn);
      task.history.push(message);
      task.status = {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString()
      };
      task.metadata = {
        ...(task.metadata ?? {}),
        workflowInstanceId: workflowId,
        turn
      };
      const acceptedTask = accepted(task, workflowId, turn, true);
      assertWorkflowPayloadSize(
        acceptedTask.params,
        this.workflowAgentIdentity
      );
      this.updateTask(task, workflowId, turn);
      this.appendStatusEvent(task);
      return acceptedTask;
    });
    this.wake(taskId);
    return result;
  }

  /** Marks the accepted turn working if it is still current and non-terminal. */
  markWorking(taskId: string, turn: number): void {
    this.prepareLegacyTaskForMutation(taskId);
    const changed = this.storage.transactionSync(() => {
      const row = this.taskRow(taskId);
      if (!row || row.turn !== turn || isTerminalState(row.state)) return false;
      if (this.cancellationRow(taskId)) return false;
      const task = this.taskFromRow(row);
      if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED)
        return false;
      if (task.status?.state === TaskState.TASK_STATE_WORKING) return false;
      task.status = {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: new Date().toISOString()
      };
      this.updateTask(task, row.workflow_instance_id, row.turn);
      this.appendStatusEvent(task);
      return true;
    });
    if (changed) this.wake(taskId);
  }

  /** Arms the earliest needed alarm for pending launches or cancellations. */
  async armRecovery(delayMilliseconds = 1_000, replace = false): Promise<void> {
    const target = Date.now() + delayMilliseconds;
    const current = await this.recoveryAlarm.getAlarm();
    if (replace || current === null || current > target) {
      await this.recoveryAlarm.setAlarm(target);
    }
  }

  /** Reconstructs Workflow parameters for tasks still waiting to be launched. */
  pendingLaunches(): PendingLaunch[] {
    return this.storage.transactionSync(() => {
      const cursor = this.recoveryCursor("launch");
      const rows = this.launchRowsAfter(cursor, ">", RECOVERY_BATCH_SIZE);
      const remaining = RECOVERY_BATCH_SIZE - rows.length;
      if (remaining > 0) {
        rows.push(...this.launchRowsAfter(cursor, "<=", remaining));
      }
      this.advanceRecoveryCursor("launch", rows.at(-1)?.id);
      return rows.map((row) => {
        const task = this.taskFromRow(row);
        return {
          workflowInstanceId: row.workflow_instance_id,
          params: acceptedResult(task, row, true).params
        };
      });
    });
  }

  /** Returns durable cancellation work before launch recovery is attempted. */
  pendingCancellations(): CancellationTarget[] {
    return this.storage.transactionSync(() => {
      const cursor = this.recoveryCursor("cancellation");
      const rows = this.cancellationRowsAfter(cursor, ">", RECOVERY_BATCH_SIZE);
      const remaining = RECOVERY_BATCH_SIZE - rows.length;
      if (remaining > 0) {
        rows.push(...this.cancellationRowsAfter(cursor, "<=", remaining));
      }
      this.advanceRecoveryCursor("cancellation", rows.at(-1)?.task_id);
      return rows.map((row) => cancellationTarget(row));
    });
  }

  /** Returns a bounded round-robin batch of durable onCancel deliveries. */
  pendingCancellationHooks(): PendingCancellationHook[] {
    if (!this.durableCancellationHook) return [];
    return this.storage.transactionSync(() => {
      const cursor = this.recoveryCursor("cancellation-hook");
      const rows = this.cancellationHookRowsAfter(
        cursor,
        ">",
        RECOVERY_BATCH_SIZE
      );
      const remaining = RECOVERY_BATCH_SIZE - rows.length;
      if (remaining > 0) {
        rows.push(...this.cancellationHookRowsAfter(cursor, "<=", remaining));
      }
      this.advanceRecoveryCursor("cancellation-hook", rows.at(-1)?.task_id);
      return rows.map((row) => ({
        taskId: row.task_id,
        task: deserializeTask(row.data)
      }));
    });
  }

  /** Deletes an onCancel outbox item only after the callback succeeds. */
  acknowledgeCancellationHook(taskId: string): void {
    this.sql.exec(
      "DELETE FROM a2a_cancellation_hooks WHERE task_id = ?",
      taskId
    );
  }

  /** Returns a bounded round-robin batch of active turns to inspect. */
  pendingWorkflowReconciliations(): WorkflowReconciliationTarget[] {
    return this.storage.transactionSync(() => {
      const cursor = this.recoveryCursor("workflow-terminal");
      const rows = this.workingRowsAfter(cursor, ">", RECOVERY_BATCH_SIZE);
      const remaining = RECOVERY_BATCH_SIZE - rows.length;
      if (remaining > 0) {
        rows.push(...this.workingRowsAfter(cursor, "<=", remaining));
      }
      this.advanceRecoveryCursor("workflow-terminal", rows.at(-1)?.id);
      return rows.map((row) => ({
        taskId: row.id,
        turn: row.turn,
        workflowInstanceId: row.workflow_instance_id
      }));
    });
  }

  /** Fails a still-current task when its Workflow can no longer callback. */
  reconcileWorkflowTerminal(
    target: WorkflowReconciliationTarget,
    status: WorkflowTerminalStatus,
    error?: { name: string; message: string }
  ): boolean {
    this.prepareLegacyTaskForMutation(target.taskId);
    const reason = workflowTerminalReason(status, error);
    const changed = this.storage.transactionSync(() => {
      const row = this.taskRow(target.taskId);
      if (
        !row ||
        row.state !== TaskState.TASK_STATE_WORKING ||
        row.turn !== target.turn ||
        row.workflow_instance_id !== target.workflowInstanceId ||
        this.cancellationRow(target.taskId)
      ) {
        return false;
      }
      const task = this.taskFromRow(row);
      const message = agentMessage(
        task.id,
        task.contextId,
        `Task failed: ${reason}`,
        `workflow-reconciliation.${row.turn}`
      );
      if (!task.history.some((item) => item.messageId === message.messageId)) {
        task.history.push(message);
      }
      task.status = {
        state: TaskState.TASK_STATE_FAILED,
        message,
        timestamp: new Date().toISOString()
      };
      this.updateTask(task, row.workflow_instance_id, row.turn);
      this.deleteCancellationIntent(task.id);
      this.appendStatusEvent(task);
      return true;
    });
    if (changed) this.wake(target.taskId);
    return changed;
  }

  /** Checks whether another alarm is needed after one recovery pass. */
  hasPendingRecovery(): boolean {
    const workflowRecovery =
      this.sql
        .exec<CountRow>(
          `SELECT (
           EXISTS(
             SELECT 1 FROM a2a_cancellation_intents AS cancellations
             LEFT JOIN a2a_tasks AS tasks ON tasks.id = cancellations.task_id
             WHERE tasks.id IS NULL OR tasks.normalized = ?
           ) OR
           EXISTS(
             SELECT 1 FROM a2a_tasks AS tasks
             LEFT JOIN a2a_cancellation_intents AS cancellations
               ON cancellations.task_id = tasks.id
                WHERE tasks.state = ? AND tasks.normalized = ?
                 AND cancellations.task_id IS NULL
           ) OR
           EXISTS(
             SELECT 1 FROM a2a_tasks AS tasks
             LEFT JOIN a2a_cancellation_intents AS cancellations
               ON cancellations.task_id = tasks.id
               WHERE tasks.state = ? AND tasks.normalized = ?
                AND cancellations.task_id IS NULL
           )
         ) AS count`,
          LEGACY_TASK_NORMALIZED,
          TaskState.TASK_STATE_SUBMITTED,
          LEGACY_TASK_NORMALIZED,
          TaskState.TASK_STATE_WORKING,
          LEGACY_TASK_NORMALIZED
        )
        .one().count > 0;
    if (workflowRecovery) return true;
    return (
      this.durableCancellationHook &&
      this.sql
        .exec<CountRow>(
          "SELECT EXISTS(SELECT 1 FROM a2a_cancellation_hooks) AS count"
        )
        .one().count > 0
    );
  }

  /** Fails durable work that cannot be retried after the alarm OOM breaker seals. */
  sealPendingRecovery(reason: string): number {
    const failureReason = truncateUtf8(
      reason,
      MAX_WORKFLOW_TERMINAL_REASON_BYTES
    );
    const timestamp = new Date().toISOString();
    const failedAt = Date.now();
    const sealed = this.storage.transactionSync(() => {
      const count = this.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM a2a_tasks AS tasks
           WHERE tasks.state IN (?, ?) OR (
             tasks.state NOT IN (?, ?, ?, ?) AND EXISTS (
               SELECT 1 FROM a2a_cancellation_intents AS cancellations
               WHERE cancellations.task_id = tasks.id
             )
           )`,
          TaskState.TASK_STATE_SUBMITTED,
          TaskState.TASK_STATE_WORKING,
          ...TERMINAL_STATES
        )
        .one().count;
      if (count > 0) {
        this.sql.exec(
          `INSERT INTO a2a_task_history (task_id, position, data)
           SELECT tasks.id,
             COALESCE((
               SELECT MAX(history.position) + 1 FROM a2a_task_history AS history
               WHERE history.task_id = tasks.id
             ), 0),
             json_object(
               'messageId', ? || tasks.id || '.memory-limit-recovery.' || tasks.turn,
               'contextId', tasks.context_id,
               'taskId', tasks.id,
               'role', 'ROLE_AGENT',
               'parts', json_array(json_object(
                 'text', 'Task failed: ' || ?,
                 'metadata', json_object(),
                 'mediaType', 'text/plain'
               )),
               'metadata', json_object()
             )
           FROM a2a_tasks AS tasks
           WHERE tasks.state IN (?, ?) OR (
             tasks.state NOT IN (?, ?, ?, ?) AND EXISTS (
               SELECT 1 FROM a2a_cancellation_intents AS cancellations
               WHERE cancellations.task_id = tasks.id
             )
           )`,
          SERVER_MESSAGE_ID_PREFIX,
          failureReason,
          TaskState.TASK_STATE_SUBMITTED,
          TaskState.TASK_STATE_WORKING,
          ...TERMINAL_STATES
        );
        if (this.durableEvents) {
          this.sql.exec(
            `INSERT INTO a2a_task_events (task_id, data, created_at)
             SELECT tasks.id,
               json_object(
                 'statusUpdate', json_object(
                   'taskId', tasks.id,
                   'contextId', tasks.context_id,
                   'status', json_object(
                     'state', 'TASK_STATE_FAILED',
                     'message', json_object(
                       'messageId', ? || tasks.id || '.memory-limit-recovery.' || tasks.turn,
                       'contextId', tasks.context_id,
                       'taskId', tasks.id,
                       'role', 'ROLE_AGENT',
                       'parts', json_array(json_object(
                         'text', 'Task failed: ' || ?,
                         'metadata', json_object(),
                         'mediaType', 'text/plain'
                       )),
                       'metadata', json_object()
                     ),
                     'timestamp', ?
                   ),
                   'metadata', json_object()
                 )
               ),
               ?
             FROM a2a_tasks AS tasks
             WHERE tasks.state IN (?, ?) OR (
               tasks.state NOT IN (?, ?, ?, ?) AND EXISTS (
                 SELECT 1 FROM a2a_cancellation_intents AS cancellations
                 WHERE cancellations.task_id = tasks.id
               )
             )`,
            SERVER_MESSAGE_ID_PREFIX,
            failureReason,
            timestamp,
            failedAt,
            TaskState.TASK_STATE_SUBMITTED,
            TaskState.TASK_STATE_WORKING,
            ...TERMINAL_STATES
          );
        }
        this.sql.exec(
          `UPDATE a2a_tasks AS tasks SET
             state = ?,
             status_timestamp = ?,
             updated_at = ?,
             data = json_set(
               tasks.data,
               '$.status',
               json_object(
                 'state', 'TASK_STATE_FAILED',
                 'message', json_object(
                   'messageId', ? || tasks.id || '.memory-limit-recovery.' || tasks.turn,
                   'contextId', tasks.context_id,
                   'taskId', tasks.id,
                   'role', 'ROLE_AGENT',
                   'parts', json_array(json_object(
                     'text', 'Task failed: ' || ?,
                     'metadata', json_object(),
                     'mediaType', 'text/plain'
                   )),
                   'metadata', json_object()
                 ),
                 'timestamp', ?
               )
             )
           WHERE tasks.state IN (?, ?) OR (
             tasks.state NOT IN (?, ?, ?, ?) AND EXISTS (
               SELECT 1 FROM a2a_cancellation_intents AS cancellations
               WHERE cancellations.task_id = tasks.id
             )
           )`,
          TaskState.TASK_STATE_FAILED,
          timestamp,
          failedAt,
          SERVER_MESSAGE_ID_PREFIX,
          failureReason,
          timestamp,
          TaskState.TASK_STATE_SUBMITTED,
          TaskState.TASK_STATE_WORKING,
          ...TERMINAL_STATES
        );
      }
      this.sql.exec(
        `DELETE FROM a2a_cancellation_intents
         WHERE NOT EXISTS (
           SELECT 1 FROM a2a_tasks AS tasks
           WHERE tasks.id = a2a_cancellation_intents.task_id
             AND tasks.state NOT IN (?, ?, ?, ?)
         )`,
        ...TERMINAL_STATES
      );
      this.sql.exec(
        `INSERT OR REPLACE INTO a2a_cancellation_hook_dead_letters (
           task_id, data, failed_at, reason
         ) SELECT task_id, data, ?, ? FROM a2a_cancellation_hooks`,
        failedAt,
        failureReason
      );
      this.sql.exec("DELETE FROM a2a_cancellation_hooks");
      return count;
    });
    for (const taskId of [...this.waiters.keys()]) this.wake(taskId);
    return sealed;
  }

  /** Resolves a legacy omitted turn only while the stored task is still turn 1. */
  resolveWorkflowCallbackTurn(
    taskId: string,
    turn: number | undefined,
    operation = "Workflow callback"
  ): number {
    const row = this.taskRow(taskId);
    if (!row) throw new Error(`Task ${taskId} was not found.`);
    if (row.normalized === LEGACY_TASK_QUARANTINED) {
      throw new Error(`Task ${taskId} is quarantined and read-only.`);
    }
    if (turn !== undefined) {
      assertPositiveTurn(turn, operation);
      return turn;
    }
    if (row.turn !== 1) {
      throw new Error(
        `${operation} omitted its turn, but Task ${taskId} is on turn ${row.turn}.`
      );
    }
    return 1;
  }

  /** Checks completion eligibility before any configured artifact generator runs. */
  completableWorkflowTurn(
    taskId: string,
    turn: number | undefined
  ): number | undefined {
    const resolved = this.resolveWorkflowCallbackTurn(
      taskId,
      turn,
      "Completion"
    );
    const row = this.taskRow(taskId);
    if (
      !row ||
      row.turn !== resolved ||
      !canApplyTurnCallback(row.state, TaskState.TASK_STATE_COMPLETED)
    )
      return undefined;
    return resolved;
  }

  /**
   * Applies artifacts and completion for the current turn, then appends
   * durable artifact and status events for live or resumed streams.
   */
  completeInternal(
    taskId: string,
    response: string,
    artifacts: Artifact[],
    metadata: Record<string, unknown> = {},
    turn: number
  ): void {
    assertPositiveTurn(turn, "Completion");
    assertJsonObject(metadata, "Completion metadata");
    validateArtifactValues(artifacts, "Completion artifacts");
    this.prepareLegacyTaskForMutation(taskId);
    const changed = this.storage.transactionSync(() => {
      const row = this.taskRow(taskId);
      if (!row) throw new Error(`Task ${taskId} was not found.`);
      if (
        !canApplyTurnCallback(row.state, TaskState.TASK_STATE_COMPLETED) ||
        row.turn !== turn
      ) {
        return false;
      }
      const task = this.taskFromRow(row);
      for (const artifact of artifacts) {
        const index = task.artifacts.findIndex(
          (item) => item.artifactId === artifact.artifactId
        );
        if (index === -1) task.artifacts.push(artifact);
        else task.artifacts[index] = artifact;
      }
      const currentTurn = row.turn;
      const message = agentMessage(
        task.id,
        task.contextId,
        response,
        currentTurn === 1 ? "response" : `response.${currentTurn}`
      );
      if (!task.history.some((item) => item.messageId === message.messageId)) {
        task.history.push(message);
      }
      task.status = {
        state: TaskState.TASK_STATE_COMPLETED,
        message,
        timestamp: new Date().toISOString()
      };
      if (Object.keys(metadata).length > 0) {
        task.metadata = { ...(task.metadata ?? {}), ...metadata };
      }
      this.updateTask(task, row.workflow_instance_id, row.turn);
      this.deleteCancellationIntent(task.id);
      for (const artifact of artifacts) {
        this.appendEvent(task.id, {
          payload: {
            $case: "artifactUpdate",
            value: {
              taskId: task.id,
              contextId: task.contextId,
              artifact,
              append: false,
              lastChunk: true,
              metadata: {}
            }
          }
        });
      }
      this.appendStatusEvent(task);
      return true;
    });
    if (changed) this.wake(taskId);
  }

  /** Persists and emits one intermediate artifact for the current active turn. */
  publishArtifactInternal(
    taskId: string,
    publicationId: string,
    artifact: Artifact,
    turn: number
  ): void {
    assertPositiveTurn(turn, "Artifact publication");
    validateArtifactValue(artifact, "Artifact publication artifact");
    if (typeof publicationId !== "string" || !publicationId.trim()) {
      throw new Error(
        "Artifact publication requires a non-empty publicationId."
      );
    }
    if (
      textEncoder.encode(publicationId).byteLength >
      MAX_ARTIFACT_PUBLICATION_ID_BYTES
    ) {
      throw new Error(
        `Artifact publicationId exceeds ${MAX_ARTIFACT_PUBLICATION_ID_BYTES} UTF-8 bytes.`
      );
    }
    this.prepareLegacyTaskForMutation(taskId);
    const artifactBytes = textEncoder.encode(
      JSON.stringify(Artifact.toJSON(artifact))
    ).byteLength;
    if (artifactBytes > MAX_INTERMEDIATE_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact publication exceeds ${MAX_INTERMEDIATE_ARTIFACT_BYTES} bytes.`
      );
    }
    const fingerprint = canonicalJson(Artifact.toJSON(artifact));
    const published = this.storage.transactionSync(() => {
      const prior = this.artifactPublication(taskId, turn, publicationId);
      if (prior) {
        if (prior.fingerprint === fingerprint) {
          return false;
        }
        throw new Error(
          `Artifact publicationId ${publicationId} was already used for different input.`
        );
      }
      const row = this.taskRow(taskId);
      if (!row) throw new Error(`Task ${taskId} was not found.`);
      if (row.turn !== turn) {
        throw new Error(`Task ${taskId} is no longer on turn ${turn}.`);
      }
      if (
        row.state !== TaskState.TASK_STATE_SUBMITTED &&
        row.state !== TaskState.TASK_STATE_WORKING
      ) {
        throw new Error(`Task ${taskId} is not SUBMITTED or WORKING.`);
      }
      if (
        this.artifactEventCount(taskId) >=
        MAX_INTERMEDIATE_ARTIFACT_PUBLICATIONS
      ) {
        throw new Error(
          `Task ${taskId} has reached the intermediate artifact publication limit.`
        );
      }
      const task = this.taskFromRow(row);
      const wasSubmitted = row.state === TaskState.TASK_STATE_SUBMITTED;
      if (wasSubmitted) {
        task.status = {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString()
        };
      }
      const index = task.artifacts.findIndex(
        (item) => item.artifactId === artifact.artifactId
      );
      if (index === -1) task.artifacts.push(artifact);
      else task.artifacts[index] = artifact;
      this.updateTask(task, row.workflow_instance_id, row.turn);
      if (wasSubmitted) this.appendStatusEvent(task);
      this.appendEvent(task.id, {
        payload: {
          $case: "artifactUpdate",
          value: {
            taskId: task.id,
            contextId: task.contextId,
            artifact,
            append: false,
            lastChunk: true,
            metadata: {}
          }
        }
      });
      this.registerArtifactPublication(
        publicationId,
        taskId,
        turn,
        fingerprint
      );
      return true;
    });
    if (published) this.wake(taskId);
  }

  private artifactPublication(
    taskId: string,
    turn: number,
    publicationId: string
  ): ArtifactPublicationRow | undefined {
    return this.sql
      .exec<ArtifactPublicationRow>(
        `SELECT publication_id, task_id, turn, fingerprint
         FROM a2a_artifact_publications
         WHERE task_id = ? AND turn = ? AND publication_id = ?`,
        taskId,
        turn,
        publicationId
      )
      .toArray()[0];
  }

  private registerArtifactPublication(
    publicationId: string,
    taskId: string,
    turn: number,
    fingerprint: string
  ): void {
    this.sql.exec(
      `INSERT INTO a2a_artifact_publications (
         publication_id, task_id, turn, fingerprint, published_at
       ) VALUES (?, ?, ?, ?, ?)`,
      publicationId,
      taskId,
      turn,
      fingerprint,
      Date.now()
    );
  }

  private artifactEventCount(taskId: string): number {
    return this.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count FROM a2a_artifact_publications
         WHERE task_id = ?`,
        taskId
      )
      .one().count;
  }

  /** Records an allowed failure for the supplied active turn. */
  failInternal(taskId: string, reason: string, turn: number): void {
    assertPositiveTurn(turn, "Failure");
    this.prepareLegacyTaskForMutation(taskId);
    const row = this.taskRow(taskId);
    const changed = row
      ? this.transitionWithMessage(
          taskId,
          turn,
          TaskState.TASK_STATE_FAILED,
          `Task failed: ${reason}`,
          `failure.${turn}`
        )
      : false;
    if (!row) throw new Error(`Task ${taskId} was not found.`);
    if (changed) this.wake(taskId);
  }

  /** Pauses the current turn with an agent question that permits one continuation. */
  requireInputInternal(taskId: string, question: string, turn: number): void {
    assertPositiveTurn(turn, "Input-required");
    this.prepareLegacyTaskForMutation(taskId);
    const row = this.taskRow(taskId);
    const changed = row
      ? this.transitionWithMessage(
          taskId,
          turn,
          TaskState.TASK_STATE_INPUT_REQUIRED,
          question,
          `clarification.${turn}`
        )
      : false;
    if (!row) throw new Error(`Task ${taskId} was not found.`);
    if (changed) this.wake(taskId);
  }

  /** Durably records the current Workflow turn before external termination. */
  beginCancellation(
    taskId: string,
    context: ServerCallContext
  ): CancellationPreparation {
    const owner = authenticatedOwner(context);
    this.prepareLegacyTaskForMutation(taskId, owner);
    const result =
      this.storage.transactionSync<CancellationPreparationInternal>(() => {
        const row = this.taskRow(taskId, owner);
        if (!row) throw new TaskNotFoundError(`Task not found: ${taskId}`);
        if (row.normalized === LEGACY_TASK_QUARANTINED) {
          throw new UnsupportedOperationError(
            `Task ${taskId} is quarantined and read-only.`
          );
        }
        const task = this.taskFromRow(row);
        if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
          this.deleteCancellationIntent(taskId);
          return { status: "canceled", task };
        }
        if (isTerminal(task)) {
          this.deleteCancellationIntent(taskId);
          return { status: "terminal", task };
        }

        const existing = this.cancellationRow(taskId);
        if (
          existing?.workflow_instance_id === row.workflow_instance_id &&
          existing.turn === row.turn
        ) {
          return { status: "pending", target: cancellationTarget(existing) };
        }

        const target = this.targetForTask(task, row);
        this.writeCancellationIntent(target);
        return { status: "pending", target };
      });
    if (result.status === "terminal") {
      throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
    }
    return result;
  }

  /** Finalizes the persisted cancellation intent for an authenticated caller. */
  cancelAfterTermination(
    taskId: string,
    target: CancellationTarget,
    context: ServerCallContext
  ): CancellationCompletion | undefined {
    const owner = authenticatedOwner(context);
    this.prepareLegacyTaskForMutation(taskId, owner);
    const result = this.finalizeCancellation(taskId, target, owner);
    if (result.status === "terminal") {
      throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
    }
    if (result.status === "stale") return undefined;
    if (result.completion.newlyCanceled) this.wake(taskId);
    return result.completion;
  }

  /** Finalizes alarm-recovered cancellation and returns only a new transition. */
  recoverCancellationAfterTermination(
    target: CancellationTarget
  ): Task | undefined {
    this.prepareLegacyTaskForMutation(target.taskId);
    const result = this.finalizeCancellation(target.taskId, target);
    if (result.status !== "canceled" || !result.completion.newlyCanceled) {
      return undefined;
    }
    this.wake(target.taskId);
    return result.completion.task;
  }

  /** Commits CANCELED only while the durable intent still targets this turn. */
  private finalizeCancellation(
    taskId: string,
    target: CancellationTarget,
    owner?: string
  ): CancellationFinalization {
    return this.storage.transactionSync(() => {
      const row = this.taskRow(taskId, owner);
      if (!row) {
        if (owner) throw new TaskNotFoundError(`Task not found: ${taskId}`);
        this.deleteCancellationIntent(taskId);
        return { status: "stale" };
      }
      const task = this.taskFromRow(row);
      if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
        this.deleteCancellationIntent(taskId);
        return {
          status: "canceled",
          completion: { newlyCanceled: false, task }
        };
      }
      if (isTerminal(task)) {
        this.deleteCancellationIntent(taskId);
        return { status: "terminal", task };
      }

      const intent = this.cancellationRow(taskId);
      if (
        !intent ||
        intent.workflow_instance_id !== target.workflowInstanceId ||
        intent.turn !== target.turn
      ) {
        return { status: "stale" };
      }
      if (
        row.workflow_instance_id !== target.workflowInstanceId ||
        row.turn !== target.turn
      ) {
        this.writeCancellationIntent(this.targetForTask(task, row));
        return { status: "stale" };
      }

      const message = agentMessage(
        task.id,
        task.contextId,
        "Task cancellation requested by the caller.",
        "cancellation"
      );
      if (!task.history.some((item) => item.messageId === message.messageId)) {
        task.history.push(message);
      }
      task.status = {
        state: TaskState.TASK_STATE_CANCELED,
        message,
        timestamp: new Date().toISOString()
      };
      this.updateTask(task, row.workflow_instance_id, row.turn);
      this.appendStatusEvent(task);
      if (this.durableCancellationHook) this.enqueueCancellationHook(task);
      this.deleteCancellationIntent(taskId);
      return {
        status: "canceled",
        completion: { newlyCanceled: true, task }
      };
    });
  }

  /** Captures the exact launch payload only when a missing instance must be created. */
  private targetForTask(task: Task, row: TaskRow): CancellationTarget {
    const candidate =
      row.state === TaskState.TASK_STATE_SUBMITTED
        ? acceptedResult(task, row, true).params
        : undefined;
    const params =
      candidate && workflowPayloadFits(candidate, this.workflowAgentIdentity)
        ? candidate
        : undefined;
    return {
      allowMissing: params === undefined,
      taskId: task.id,
      turn: row.turn,
      workflowInstanceId: row.workflow_instance_id,
      ...(params ? { params } : {})
    };
  }

  private cancellationRow(taskId: string): CancellationRow | undefined {
    return this.sql
      .exec<CancellationRow>(
        "SELECT * FROM a2a_cancellation_intents WHERE task_id = ?",
        taskId
      )
      .toArray()[0];
  }

  private writeCancellationIntent(target: CancellationTarget): void {
    this.sql.exec(
      `INSERT INTO a2a_cancellation_intents (
         task_id, workflow_instance_id, turn, params, requested_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         workflow_instance_id = excluded.workflow_instance_id,
         turn = excluded.turn,
         params = excluded.params,
         requested_at = excluded.requested_at`,
      target.taskId,
      target.workflowInstanceId,
      target.turn,
      target.params ? JSON.stringify(target.params) : null,
      Date.now()
    );
  }

  private deleteCancellationIntent(taskId: string): void {
    this.sql.exec(
      "DELETE FROM a2a_cancellation_intents WHERE task_id = ?",
      taskId
    );
  }

  private enqueueCancellationHook(task: Task): void {
    this.sql.exec(
      `INSERT INTO a2a_cancellation_hooks (task_id, data, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO NOTHING`,
      task.id,
      JSON.stringify(Task.toJSON(task)),
      Date.now()
    );
  }

  private advanceRecoveryCursor(kind: string, taskId?: string): void {
    if (!taskId) return;
    this.sql.exec(
      `INSERT INTO a2a_recovery_cursors (kind, task_id) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET task_id = excluded.task_id`,
      kind,
      taskId
    );
  }

  private recoveryCursor(kind: string): string {
    return (
      this.sql
        .exec<{ task_id: string }>(
          "SELECT task_id FROM a2a_recovery_cursors WHERE kind = ?",
          kind
        )
        .toArray()[0]?.task_id ?? ""
    );
  }

  private launchRowsAfter(
    cursor: string,
    comparison: ">" | "<=",
    limit: number
  ): TaskRow[] {
    return this.sql
      .exec<TaskRow>(
        `SELECT tasks.* FROM a2a_tasks AS tasks
         LEFT JOIN a2a_cancellation_intents AS cancellations
           ON cancellations.task_id = tasks.id
         WHERE tasks.state = ? AND cancellations.task_id IS NULL
            AND tasks.normalized = ?
           AND tasks.id ${comparison} ?
         ORDER BY tasks.id
         LIMIT ?`,
        TaskState.TASK_STATE_SUBMITTED,
        LEGACY_TASK_NORMALIZED,
        cursor,
        limit
      )
      .toArray();
  }

  private cancellationRowsAfter(
    cursor: string,
    comparison: ">" | "<=",
    limit: number
  ): CancellationRow[] {
    return this.sql
      .exec<CancellationRow>(
        `SELECT cancellations.* FROM a2a_cancellation_intents AS cancellations
         LEFT JOIN a2a_tasks AS tasks ON tasks.id = cancellations.task_id
          WHERE (tasks.id IS NULL OR tasks.normalized = ?)
           AND cancellations.task_id ${comparison} ?
         ORDER BY cancellations.task_id
         LIMIT ?`,
        LEGACY_TASK_NORMALIZED,
        cursor,
        limit
      )
      .toArray();
  }

  private cancellationHookRowsAfter(
    cursor: string,
    comparison: ">" | "<=",
    limit: number
  ): CancellationHookRow[] {
    return this.sql
      .exec<CancellationHookRow>(
        `SELECT task_id, data FROM a2a_cancellation_hooks
         WHERE task_id ${comparison} ?
         ORDER BY task_id
         LIMIT ?`,
        cursor,
        limit
      )
      .toArray();
  }

  private workingRowsAfter(
    cursor: string,
    comparison: ">" | "<=",
    limit: number
  ): TaskRow[] {
    return this.sql
      .exec<TaskRow>(
        `SELECT tasks.* FROM a2a_tasks AS tasks
         LEFT JOIN a2a_cancellation_intents AS cancellations
           ON cancellations.task_id = tasks.id
         WHERE tasks.state = ? AND cancellations.task_id IS NULL
            AND tasks.normalized = ?
           AND tasks.id ${comparison} ?
         ORDER BY tasks.id
         LIMIT ?`,
        TaskState.TASK_STATE_WORKING,
        LEGACY_TASK_NORMALIZED,
        cursor,
        limit
      )
      .toArray();
  }

  /** Adds one unique metadata item for the current turn or reports cancellation. */
  appendMetadataItem(
    taskId: string,
    key: string,
    item: unknown,
    turn: number
  ): MetadataAppendResult {
    assertJsonCompatible(item, "Metadata item");
    this.prepareLegacyTaskForMutation(taskId);
    return this.storage.transactionSync(() => {
      const row = this.taskRow(taskId);
      if (!row) throw new Error(`Task ${taskId} was not found.`);
      const task = this.taskFromRow(row);
      if (row.state === TaskState.TASK_STATE_CANCELED) {
        return { status: "canceled", task };
      }
      if (isTerminalState(row.state)) {
        throw new Error(
          `Task ${taskId} is terminal and metadata cannot be changed.`
        );
      }
      if (row.turn !== turn)
        throw new Error(`Task ${taskId} is no longer on turn ${turn}.`);
      const appended = appendUniqueTaskMetadataItem(task, key, item);
      if (appended) {
        this.updateTask(task, row.workflow_instance_id, row.turn);
      }
      return { status: appended ? "appended" : "duplicate", task };
    });
  }

  /** Reads a task and its event cursor together before a stream starts tailing updates. */
  async streamSnapshot(
    taskId: string,
    context: ServerCallContext,
    historyLength?: number
  ): Promise<TaskStreamSnapshot> {
    const row = this.taskRow(taskId, authenticatedOwner(context));
    if (!row) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    if (row.normalized === LEGACY_TASK_PENDING) await this.armRecovery();
    const sequence = this.sql
      .exec<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM a2a_task_events WHERE task_id = ?",
        taskId
      )
      .one().sequence;
    return { task: this.taskFromRow(row, { historyLength }), sequence };
  }

  /** Returns durable stream events after the caller's last observed sequence. */
  eventsAfter(taskId: string, sequence: number): DurableTaskEvent[] {
    const events: DurableTaskEvent[] = [];
    let cursor = sequence;
    let bytes = 0;
    while (events.length < MAX_EVENTS_PER_BATCH) {
      const limit = Math.min(
        EVENT_SQL_BATCH_SIZE,
        MAX_EVENTS_PER_BATCH - events.length
      );
      const rows = this.sql
        .exec<EventRow>(
          `SELECT sequence, data FROM a2a_task_events
           WHERE task_id = ? AND sequence > ?
           ORDER BY sequence LIMIT ?`,
          taskId,
          cursor,
          limit
        )
        .toArray();
      if (rows.length === 0) break;
      for (const row of rows) {
        const rowBytes = textEncoder.encode(row.data).byteLength;
        if (bytes + rowBytes > MAX_EVENT_BATCH_BYTES) {
          if (events.length === 0) {
            throw new Error(
              `Persisted event ${row.sequence} exceeds the event batch byte budget.`
            );
          }
          return events;
        }
        bytes += rowBytes;
        cursor = row.sequence;
        events.push({
          sequence: row.sequence,
          response: deserializeStreamResponse(row.data)
        });
      }
      if (rows.length < limit) break;
    }
    return events;
  }

  /** Registers a bounded in-memory wake-up for new events or request cancellation. */
  waitForUpdate(taskId: string, signal?: AbortSignal): EventWaiter {
    let settled = false;
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const current = this.waiters.get(taskId);
      current?.delete(settle);
      if (current?.size === 0) this.waiters.delete(taskId);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    };
    const timeout = setTimeout(settle, 5_000);
    const taskWaiters = this.waiters.get(taskId) ?? new Set<() => void>();
    taskWaiters.add(settle);
    this.waiters.set(taskId, taskWaiters);
    signal?.addEventListener("abort", settle, { once: true });
    if (signal?.aborted) settle();
    return { promise, cancel: settle };
  }

  /** Checks whether a stream should stop because input or a final state was reached. */
  isInterruptedOrTerminal(taskId: string): boolean {
    const row = this.taskRow(taskId);
    return (
      row === undefined ||
      row.state === TaskState.TASK_STATE_INPUT_REQUIRED ||
      row.state === TaskState.TASK_STATE_AUTH_REQUIRED ||
      isTerminalState(row.state)
    );
  }

  /** Replays matching message IDs and rejects reuse with different canonical input. */
  private acceptedTask(
    contextId: string,
    messageId: string,
    fingerprint: string,
    owner: string
  ): AcceptedTask | undefined {
    const accepted = this.messageRegistration(contextId, messageId);
    if (!accepted) return undefined;
    if (accepted.fingerprint !== fingerprint) {
      throw new RequestMalformedError(
        `messageId ${messageId} was already used for different input.`
      );
    }
    const row = this.taskRow(accepted.task_id, owner);
    if (!row)
      throw new TaskNotFoundError(`Task not found: ${accepted.task_id}`);
    return acceptedResult(
      this.taskFromRow(row),
      row,
      row.state === TaskState.TASK_STATE_SUBMITTED &&
        this.cancellationRow(accepted.task_id) === undefined
    );
  }

  /** Applies one turn-fenced status transition and emits its durable stream event. */
  private transitionWithMessage(
    taskId: string,
    turn: number,
    state: TaskState,
    text: string,
    messageKey: string
  ): boolean {
    return this.storage.transactionSync(() => {
      const row = this.taskRow(taskId);
      if (!row || row.turn !== turn || !canApplyTurnCallback(row.state, state))
        return false;
      const task = this.taskFromRow(row);
      const message = agentMessage(task.id, task.contextId, text, messageKey);
      if (
        task.status?.state === state &&
        (task.status.message?.messageId === message.messageId ||
          task.status.message?.messageId === `${task.id}.${messageKey}`)
      ) {
        return false;
      }
      if (!task.history.some((item) => item.messageId === message.messageId)) {
        task.history.push(message);
      }
      task.status = { state, message, timestamp: new Date().toISOString() };
      this.updateTask(task, row.workflow_instance_id, row.turn);
      if (isTerminalState(state)) this.deleteCancellationIntent(taskId);
      this.appendStatusEvent(task);
      return true;
    });
  }

  /** Strictly normalizes or quarantines a legacy row before any mutation. */
  private prepareLegacyTaskForMutation(taskId: string, owner?: string): void {
    const current = this.taskRow(taskId, owner);
    if (!current || current.normalized !== LEGACY_TASK_PENDING) return;
    try {
      this.storage.transactionSync(() => {
        const row = this.taskRow(taskId, owner);
        if (row?.normalized === LEGACY_TASK_PENDING) {
          this.normalizeLegacyTask(row);
        }
      });
    } catch (error) {
      this.storage.transactionSync(() =>
        this.quarantineLegacyTask(taskId, error)
      );
      throw new UnsupportedOperationError(
        `Task ${taskId} is quarantined and read-only.`
      );
    }
  }

  /** Prevents a new ID from bypassing legacy replay rows not yet indexed. */
  private prepareMessageAcceptance(contextId: string, messageId: string): void {
    if (this.quarantinedMessageClaim(contextId, messageId)) {
      throw new RequestMalformedError(
        `messageId ${messageId} is claimed by a quarantined legacy task.`
      );
    }
    if (
      this.messageRegistration(contextId, messageId) ||
      !this.hasLegacyTasks()
    )
      return;
    this.migrateLegacyTasks();
    if (this.quarantinedMessageClaim(contextId, messageId)) {
      throw new RequestMalformedError(
        `messageId ${messageId} is claimed by a quarantined legacy task.`
      );
    }
    if (
      !this.messageRegistration(contextId, messageId) &&
      this.hasLegacyTasks()
    ) {
      throw new UnsupportedOperationError(
        "Legacy task migration is in progress; retry the message."
      );
    }
  }

  private messageRegistration(
    contextId: string,
    messageId: string
  ): MessageRow | undefined {
    return this.sql
      .exec<MessageRow>(
        `SELECT context_id, task_id, fingerprint FROM a2a_message_ids
         WHERE context_id = ? AND message_id = ?`,
        contextId,
        messageId
      )
      .toArray()[0];
  }

  private quarantinedMessageClaim(
    contextId: string,
    messageId: string
  ): boolean {
    return (
      this.sql
        .exec<CountRow>(
          `SELECT EXISTS(
           SELECT 1 FROM a2a_quarantined_message_ids
           WHERE context_id = ? AND message_id = ?
         ) AS count`,
          contextId,
          messageId
        )
        .one().count > 0
    );
  }

  private registerTaskMessageIds(task: Task, acceptedAt: number): void {
    for (const item of messageIdBackfillRows(task, acceptedAt)) {
      const existing = this.messageRegistration(item.contextId, item.messageId);
      if (existing) {
        if (
          existing.task_id !== item.taskId ||
          existing.fingerprint !== item.fingerprint
        ) {
          throw new RequestMalformedError(
            `messageId ${item.messageId} was already used for different input.`
          );
        }
        continue;
      }
      this.sql.exec(
        `INSERT INTO a2a_message_ids (
           context_id, message_id, task_id, fingerprint, accepted_at
         ) VALUES (?, ?, ?, ?, ?)`,
        item.contextId,
        item.messageId,
        item.taskId,
        item.fingerprint,
        item.acceptedAt
      );
    }
  }

  /** Migrates a small round-robin batch; each Task commits independently. */
  migrateLegacyTasks(): number {
    const cursor = this.recoveryCursor("normalization");
    const taskIds = this.legacyTaskIdsAfter(
      cursor,
      ">",
      LEGACY_MIGRATION_BATCH_SIZE
    );
    const remaining = LEGACY_MIGRATION_BATCH_SIZE - taskIds.length;
    if (remaining > 0) {
      taskIds.push(...this.legacyTaskIdsAfter(cursor, "<=", remaining));
    }

    let migrated = 0;
    for (const taskId of taskIds) {
      try {
        const changed = this.storage.transactionSync(() => {
          const row = this.taskRow(taskId);
          if (!row || row.normalized !== LEGACY_TASK_PENDING) {
            this.advanceRecoveryCursor("normalization", taskId);
            return false;
          }
          this.normalizeLegacyTask(row);
          this.advanceRecoveryCursor("normalization", taskId);
          return true;
        });
        if (changed) migrated += 1;
      } catch (error) {
        this.storage.transactionSync(() => {
          this.quarantineLegacyTask(taskId, error);
          this.advanceRecoveryCursor("normalization", taskId);
        });
        console.error(
          JSON.stringify({
            message: "legacy task normalization failed",
            taskId,
            error: error instanceof Error ? error.name : "UnknownError"
          })
        );
      }
    }
    return migrated;
  }

  /** Runs bounded migration and compaction work and reports whether more remains. */
  runMaintenance(): boolean {
    this.migrateLegacyTasks();
    if (this.durableEvents) this.compactTerminalEvents();
    this.compactTerminalTasks();
    return this.hasPendingMaintenance();
  }

  hasPendingMaintenance(): boolean {
    if (this.hasLegacyTasks()) return true;
    const now = Date.now();
    const taskCutoff = now - this.terminalTaskRetentionMilliseconds;
    const terminalTaskPending =
      this.sql
        .exec<CountRow>(
          `SELECT EXISTS(
           SELECT 1 FROM a2a_tasks
           WHERE updated_at < ? AND state IN (?, ?, ?, ?)
          ) AS count`,
          taskCutoff,
          ...TERMINAL_STATES
        )
        .one().count > 0;
    if (terminalTaskPending) return true;
    if (!this.durableEvents) return false;
    const eventCutoff = now - EVENT_RETENTION_MILLISECONDS;
    return (
      this.sql
        .exec<CountRow>(
          `SELECT EXISTS(
             SELECT 1 FROM a2a_task_events AS events
             JOIN a2a_tasks AS tasks ON tasks.id = events.task_id
             WHERE events.created_at < ? AND tasks.updated_at < ?
                AND tasks.state IN (?, ?, ?, ?, ?, ?)
           ) AS count`,
          eventCutoff,
          eventCutoff,
          ...EVENT_REPLAY_STOP_STATES
        )
        .one().count > 0
    );
  }

  /** Returns when the earliest retained stopped-task event becomes eligible. */
  nextTerminalEventCompactionAt(): number | undefined {
    if (!this.durableEvents) return undefined;
    const row = this.sql
      .exec<{ timestamp: number | null }>(
        `SELECT MIN(
           CASE
             WHEN events.created_at > tasks.updated_at THEN events.created_at
             ELSE tasks.updated_at
           END
         ) AS timestamp
         FROM a2a_task_events AS events
         JOIN a2a_tasks AS tasks ON tasks.id = events.task_id
          WHERE tasks.state IN (?, ?, ?, ?, ?, ?)`,
        ...EVENT_REPLAY_STOP_STATES
      )
      .one();
    return row.timestamp === null
      ? undefined
      : row.timestamp + EVENT_RETENTION_MILLISECONDS + 1;
  }

  /** Returns when the oldest retained terminal task becomes eligible. */
  nextTerminalTaskCompactionAt(): number | undefined {
    const row = this.sql
      .exec<{ timestamp: number | null }>(
        `SELECT MIN(updated_at) AS timestamp FROM a2a_tasks
         WHERE state IN (?, ?, ?, ?)`,
        ...TERMINAL_STATES
      )
      .one();
    return row.timestamp === null
      ? undefined
      : row.timestamp + this.terminalTaskRetentionMilliseconds + 1;
  }

  private hasLegacyTasks(): boolean {
    return (
      this.sql
        .exec<CountRow>(
          `SELECT EXISTS(
           SELECT 1 FROM a2a_tasks WHERE normalized = ?
         ) AS count`,
          LEGACY_TASK_PENDING
        )
        .one().count > 0
    );
  }

  private legacyTaskIdsAfter(
    cursor: string,
    comparison: ">" | "<=",
    limit: number
  ): string[] {
    return this.sql
      .exec<{ id: string }>(
        `SELECT id FROM a2a_tasks
         WHERE normalized = ? AND id ${comparison} ?
         ORDER BY id LIMIT ?`,
        LEGACY_TASK_PENDING,
        cursor,
        limit
      )
      .toArray()
      .map((row) => row.id);
  }

  private normalizeLegacyTask(row: TaskRow): void {
    const validated = validateTaskJson(
      parseLosslessJson(row.data),
      `Legacy Task ${row.id}`
    );
    if (validated.id !== row.id || validated.contextId !== row.context_id) {
      throw new Error(
        `Legacy Task ${row.id} has inconsistent scalar identity.`
      );
    }
    if (validated.state !== row.state) {
      throw new Error(`Legacy Task ${row.id} has inconsistent scalar state.`);
    }
    if ((validated.statusTimestamp ?? null) !== row.status_timestamp) {
      throw new Error(
        `Legacy Task ${row.id} has inconsistent status timestamp.`
      );
    }
    prepareTaskJsonForSdk(validated.value);
    const task = Task.fromJSON(validated.value);
    restoreTaskDataNull(task);
    if (row.state === TaskState.TASK_STATE_SUBMITTED) {
      assertPositiveTurn(row.turn, `Legacy Task ${row.id} Workflow`);
      assertWorkflowPayloadSize(
        acceptedResult(task, row, true).params,
        this.workflowAgentIdentity
      );
    }
    const serialized = serializeNormalizedTask(task);
    this.registerTaskMessageIds(task, row.created_at);
    this.replaceTaskChildren(task.id, serialized);
    this.sql.exec(
      "UPDATE a2a_tasks SET data = ?, normalized = ? WHERE id = ?",
      serialized.baseData,
      LEGACY_TASK_NORMALIZED,
      task.id
    );
  }

  private quarantineLegacyTask(taskId: string, error: unknown): void {
    const row = this.taskRow(taskId);
    if (!row || row.normalized !== LEGACY_TASK_PENDING) return;
    const message = truncateUtf8(
      errorMessage(error),
      MAX_LEGACY_QUARANTINE_ERROR_BYTES
    );
    this.sql.exec(
      `UPDATE a2a_tasks SET normalized = ? WHERE id = ?`,
      LEGACY_TASK_QUARANTINED,
      taskId
    );
    this.sql.exec(
      `INSERT INTO a2a_legacy_quarantine (task_id, error, quarantined_at)
       VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         error = excluded.error,
         quarantined_at = excluded.quarantined_at`,
      taskId,
      message,
      Date.now()
    );

    try {
      const task = deserializeTask(row.data);
      for (const claim of messageIdBackfillRows(task, row.created_at)) {
        this.sql.exec(
          `INSERT INTO a2a_quarantined_message_ids (
              context_id, message_id, task_id, fingerprint
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(context_id, message_id, task_id) DO UPDATE SET
              fingerprint = excluded.fingerprint`,
          claim.contextId,
          claim.messageId,
          taskId,
          claim.fingerprint
        );
      }
    } catch {
      // A row that cannot be decoded has no message ID that can be proven safely.
    }
  }

  /** Deletes a bounded batch of terminal tasks and every task-owned row. */
  private compactTerminalTasks(): number {
    const cutoff = Date.now() - this.terminalTaskRetentionMilliseconds;
    return this.storage.transactionSync(() => {
      const taskIds = this.sql
        .exec<{ id: string }>(
          `SELECT id FROM a2a_tasks
           WHERE updated_at < ? AND state IN (?, ?, ?, ?)
           ORDER BY updated_at, id LIMIT ?`,
          cutoff,
          ...TERMINAL_STATES,
          TERMINAL_TASK_COMPACTION_BATCH_SIZE
        )
        .toArray()
        .map((row) => row.id);
      if (taskIds.length === 0) return 0;
      const placeholders = taskIds.map(() => "?").join(", ");
      this.sql.exec(
        `DELETE FROM a2a_task_history WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_task_artifacts WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_message_ids WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_task_events WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_artifact_publications
         WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_cancellation_intents
         WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_cancellation_hooks
         WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_cancellation_hook_dead_letters
         WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_legacy_quarantine
         WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_quarantined_message_ids
         WHERE task_id IN (${placeholders})`,
        ...taskIds
      );
      this.sql.exec(
        `DELETE FROM a2a_tasks WHERE id IN (${placeholders})`,
        ...taskIds
      );
      return taskIds.length;
    });
  }

  /** Removes only a fixed number of old stopped-task events in one pass. */
  private compactTerminalEvents(): number {
    const cutoff = Date.now() - EVENT_RETENTION_MILLISECONDS;
    return this.storage.transactionSync(() => {
      const rows = this.sql
        .exec<{ sequence: number }>(
          `SELECT events.sequence FROM a2a_task_events AS events
           JOIN a2a_tasks AS tasks ON tasks.id = events.task_id
           WHERE events.created_at < ? AND tasks.updated_at < ?
              AND tasks.state IN (?, ?, ?, ?, ?, ?)
            ORDER BY events.sequence LIMIT ?`,
          cutoff,
          cutoff,
          ...EVENT_REPLAY_STOP_STATES,
          EVENT_COMPACTION_BATCH_SIZE
        )
        .toArray();
      if (rows.length === 0) return 0;
      this.sql.exec(
        `DELETE FROM a2a_task_events WHERE sequence IN (
           ${rows.map(() => "?").join(", ")}
         )`,
        ...rows.map((row) => row.sequence)
      );
      return rows.length;
    });
  }

  /** Persists the task's current status as an A2A streaming update. */
  private appendStatusEvent(task: Task): void {
    this.appendEvent(task.id, {
      payload: {
        $case: "statusUpdate",
        value: {
          taskId: task.id,
          contextId: task.contextId,
          status: task.status,
          metadata: {}
        }
      }
    });
  }

  private appendEvent(taskId: string, response: StreamResponse): void {
    if (!this.durableEvents) return;
    const data = JSON.stringify(StreamResponse.toJSON(response));
    const bytes = textEncoder.encode(data).byteLength;
    if (bytes > MAX_EVENT_BATCH_BYTES) {
      throw new Error(
        `Serialized event exceeds its ${MAX_EVENT_BATCH_BYTES}-byte UTF-8 budget (${bytes} bytes).`
      );
    }
    this.sql.exec(
      "INSERT INTO a2a_task_events (task_id, data, created_at) VALUES (?, ?, ?)",
      taskId,
      data,
      Date.now()
    );
  }

  private insertTask(
    task: Task,
    owner: string,
    workflowInstanceId: string,
    turn: number
  ): void {
    const serialized = serializeNormalizedTask(task);
    const now = Date.now();
    this.registerTaskMessageIds(task, now);
    this.sql.exec(
      `INSERT INTO a2a_tasks (
         id, context_id, owner, workflow_instance_id, turn, state,
         status_timestamp, created_at, updated_at, data, normalized
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      task.id,
      task.contextId,
      owner,
      workflowInstanceId,
      turn,
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
      task.status?.timestamp ?? null,
      now,
      now,
      serialized.baseData
    );
    this.replaceTaskChildren(task.id, serialized);
  }

  private updateTask(
    task: Task,
    workflowInstanceId: string,
    turn: number
  ): void {
    const existing = this.taskRow(task.id);
    if (!existing) throw new Error(`Task ${task.id} was not found.`);
    if (existing.normalized === LEGACY_TASK_QUARANTINED) {
      throw new Error(`Task ${task.id} is quarantined and read-only.`);
    }
    if (existing.normalized === LEGACY_TASK_PENDING) {
      throw new Error(`Task ${task.id} must be normalized before mutation.`);
    }
    const serialized = serializeNormalizedTask(task);
    this.registerTaskMessageIds(task, existing.created_at);
    this.sql.exec(
      `UPDATE a2a_tasks SET
         workflow_instance_id = ?, turn = ?, state = ?, status_timestamp = ?,
         updated_at = ?, data = ?, normalized = 1 WHERE id = ?`,
      workflowInstanceId,
      turn,
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
      task.status?.timestamp ?? null,
      Date.now(),
      serialized.baseData,
      task.id
    );
    this.replaceTaskChildren(task.id, serialized);
  }

  private replaceTaskChildren(
    taskId: string,
    serialized: SerializedTaskParts
  ): void {
    this.sql.exec("DELETE FROM a2a_task_history WHERE task_id = ?", taskId);
    this.sql.exec("DELETE FROM a2a_task_artifacts WHERE task_id = ?", taskId);
    serialized.historyRows.forEach((data, position) => {
      this.sql.exec(
        `INSERT INTO a2a_task_history (task_id, position, data)
         VALUES (?, ?, ?)`,
        taskId,
        position,
        data
      );
    });
    serialized.artifactRows.forEach((row, position) => {
      this.sql.exec(
        `INSERT INTO a2a_task_artifacts (
           task_id, position, artifact_id, data
         ) VALUES (?, ?, ?, ?)`,
        taskId,
        position,
        row.artifactId,
        row.data
      );
    });
  }

  private taskFromRow(row: TaskRow, options: TaskReadOptions = {}): Task {
    const task = deserializeTask(row.data);
    if (row.normalized !== LEGACY_TASK_NORMALIZED) {
      applyTaskReadOptions(task, options);
      return task;
    }

    if (options.historyLength === undefined) {
      task.history = this.sql
        .exec<TaskChildRow>(
          `SELECT position, data FROM a2a_task_history
           WHERE task_id = ? ORDER BY position`,
          row.id
        )
        .toArray()
        .map((item) => deserializeMessage(item.data));
    } else if (options.historyLength > 0) {
      task.history = this.sql
        .exec<TaskChildRow>(
          `SELECT position, data FROM a2a_task_history
           WHERE task_id = ? ORDER BY position DESC LIMIT ?`,
          row.id,
          Math.floor(options.historyLength)
        )
        .toArray()
        .reverse()
        .map((item) => deserializeMessage(item.data));
    }

    if (options.includeArtifacts !== false) {
      task.artifacts = this.sql
        .exec<TaskChildRow>(
          `SELECT position, data FROM a2a_task_artifacts
           WHERE task_id = ? ORDER BY position`,
          row.id
        )
        .toArray()
        .map((item) => deserializeArtifact(item.data));
    }
    return task;
  }

  private taskRow(taskId: string, owner?: string): TaskRow | undefined {
    const query = owner
      ? "SELECT * FROM a2a_tasks WHERE id = ? AND owner = ?"
      : "SELECT * FROM a2a_tasks WHERE id = ?";
    return this.sql
      .exec<TaskRow>(query, taskId, ...(owner ? [owner] : []))
      .toArray()[0];
  }

  /** Resolves every local stream waiter after durable state has changed. */
  private wake(taskId: string): void {
    const waiters = this.waiters.get(taskId);
    if (!waiters) return;
    this.waiters.delete(taskId);
    for (const settle of waiters) settle();
  }
}

/** Appends metadata using canonical JSON equality so callback retries are harmless. */
export function appendUniqueTaskMetadataItem(
  task: Task,
  key: string,
  item: unknown
): boolean {
  assertJsonCompatible(item, "Metadata item");
  const metadata = task.metadata ?? {};
  const current = metadata[key];
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error(`Task metadata ${key} is not an array.`);
  }
  const items: unknown[] = current ?? [];
  const serialized = canonicalJson(item);
  if (items.some((value) => canonicalJson(value) === serialized)) return false;
  task.metadata = { ...metadata, [key]: [...items, item] };
  return true;
}

/** Rejects callbacks after a final state and non-input callbacks while waiting for input. */
export function canApplyTurnCallback(
  currentState: number,
  nextState: TaskState
): boolean {
  return (
    !isTerminalState(currentState) &&
    (currentState !== TaskState.TASK_STATE_INPUT_REQUIRED ||
      nextState === TaskState.TASK_STATE_INPUT_REQUIRED)
  );
}

/** Reconstructs replay fingerprints for user messages stored before idempotency support. */
export function messageIdBackfillRows(
  task: Task,
  acceptedAt = Date.now()
): Array<{
  acceptedAt: number;
  contextId: string;
  fingerprint: string;
  messageId: string;
  taskId: string;
}> {
  let userIndex = 0;
  return task.history.flatMap((message) => {
    if (message.role !== Role.ROLE_USER || !message.messageId) return [];
    const taskIntent = userIndex++ === 0 ? "" : task.id;
    return [
      {
        acceptedAt,
        contextId: task.contextId,
        fingerprint: messageFingerprint(message, task.contextId, taskIntent),
        messageId: message.messageId,
        taskId: task.id
      }
    ];
  });
}

/** Checks whether a named schema migration has not yet reached its target version. */
export function shouldRunSchemaMigration(
  currentVersion: number | undefined,
  targetVersion: number
): boolean {
  return currentVersion === undefined || currentVersion < targetVersion;
}

/** Measures the exact UTF-8 size of the fully assembled Task JSON. */
export function serializedTaskByteLength(task: Task): number {
  return textEncoder.encode(JSON.stringify(Task.toJSON(task))).byteLength;
}

/** Throws before SQL mutation when a Task would exceed its storage budget. */
export function assertTaskFitsStorage(task: Task): void {
  serializeTaskForStorage(task);
}

function serializeTaskForStorage(task: Task): string {
  const data = JSON.stringify(Task.toJSON(task));
  const bytes = textEncoder.encode(data).byteLength;
  const budget = isTerminal(task)
    ? MAX_SERIALIZED_TASK_BYTES
    : MAX_SERIALIZED_TASK_BYTES - ACTIVE_TASK_TERMINAL_RESERVE_BYTES;
  if (bytes > budget) {
    throw new Error(
      `Serialized Task exceeds its ${budget}-byte UTF-8 storage budget (${bytes} bytes).`
    );
  }
  return data;
}

function serializeNormalizedTask(task: Task): SerializedTaskParts {
  const aggregateData = serializeTaskForStorage(task);
  const base = JSON.parse(aggregateData) as Record<string, unknown>;
  delete base.history;
  delete base.artifacts;
  return {
    baseData: JSON.stringify(base),
    historyRows: task.history.map((message) =>
      JSON.stringify(Message.toJSON(message))
    ),
    artifactRows: task.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      data: JSON.stringify(Artifact.toJSON(artifact))
    }))
  };
}

function applyTaskReadOptions(task: Task, options: TaskReadOptions): void {
  if (options.historyLength !== undefined) {
    task.history =
      options.historyLength <= 0
        ? []
        : task.history.slice(-Math.floor(options.historyLength));
  }
  if (options.includeArtifacts === false) task.artifacts = [];
}

function workflowTerminalReason(
  status: WorkflowTerminalStatus,
  error?: { name: string; message: string }
): string {
  const detail =
    status === "errored" && error ? ` (${error.name}: ${error.message})` : "";
  const reason =
    status === "missing"
      ? "Workflow instance is unavailable before persisting a terminal callback."
      : `Workflow reached ${status} before persisting a terminal callback${detail}.`;
  return truncateUtf8(reason, MAX_WORKFLOW_TERMINAL_REASON_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "...";
  const contentBudget = maxBytes - suffix.length;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength;
    if (bytes + characterBytes > contentBudget) break;
    result += character;
    bytes += characterBytes;
  }
  return result + suffix;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function accepted(
  task: Task,
  workflowInstanceId: string,
  turn: number,
  shouldStart: boolean
): AcceptedTask {
  return {
    task,
    workflowInstanceId,
    shouldStart,
    params: {
      taskId: task.id,
      contextId: task.contextId,
      prompt: latestUserText(task),
      conversation: conversationHistory(task.history),
      turn
    }
  };
}

function acceptedResult(
  task: Task,
  row: Pick<TaskRow, "workflow_instance_id" | "turn">,
  shouldStart: boolean
): AcceptedTask {
  return accepted(task, row.workflow_instance_id, row.turn, shouldStart);
}

function cancellationTarget(row: CancellationRow): CancellationTarget {
  const params =
    row.params === null
      ? undefined
      : (JSON.parse(row.params) as A2AWorkflowParams);
  return {
    allowMissing: params === undefined,
    taskId: row.task_id,
    turn: row.turn,
    workflowInstanceId: row.workflow_instance_id,
    ...(params ? { params } : {})
  };
}

export function assertWorkflowPayloadSize(
  params: A2AWorkflowParams,
  identity: WorkflowAgentIdentity
): void {
  if (workflowPayloadFits(params, identity)) return;
  throw new RequestMalformedError(
    "Workflow input exceeds Cloudflare's 1 MiB event payload limit."
  );
}

function workflowPayloadFits(
  params: A2AWorkflowParams,
  identity: WorkflowAgentIdentity
): boolean {
  const agentOrigin = {
    kind: "agent",
    version: 1,
    binding: identity.agentBinding,
    name: identity.agentName
  };
  const augmentedParams = {
    ...params,
    __agentName: identity.agentName,
    __agentBinding: identity.agentBinding,
    __workflowName: identity.workflowName,
    __agentOrigin: agentOrigin
  };
  return (
    new TextEncoder().encode(JSON.stringify(augmentedParams)).byteLength <=
    MAX_WORKFLOW_EVENT_PAYLOAD_BYTES
  );
}

function latestUserText(task: Task): string {
  const latest = [...conversationHistory(task.history)]
    .reverse()
    .find((item) => item.role === "user");
  if (!latest) throw new Error(`Task ${task.id} has no user input.`);
  return latest.text;
}

/** Returns the authenticated owner or rejects unauthenticated storage access. */
function authenticatedOwner(context: ServerCallContext): string {
  if (!context.user?.isAuthenticated) {
    throw new A2AError("An authenticated user is required.");
  }
  return context.user.userName;
}

/** Reconstructs an SDK Task from its stored JSON representation. */
function deserializeTask(data: string): Task {
  const value = JSON.parse(data) as Record<string, unknown>;
  prepareTaskJsonForSdk(value);
  const task = Task.fromJSON(value);
  restoreTaskDataNull(task);
  return task;
}

function deserializeMessage(data: string): Message {
  const value = JSON.parse(data) as Record<string, unknown>;
  prepareMessageJsonForSdk(value);
  const message = Message.fromJSON(value);
  restoreMessageDataNull(message);
  return message;
}

function deserializeArtifact(data: string): Artifact {
  const value = JSON.parse(data) as Record<string, unknown>;
  prepareArtifactJsonForSdk(value);
  const artifact = Artifact.fromJSON(value);
  restoreArtifactDataNull(artifact);
  return artifact;
}

function deserializeStreamResponse(data: string): StreamResponse {
  const value = JSON.parse(data) as Record<string, unknown>;
  if (isJsonRecord(value.task)) prepareTaskJsonForSdk(value.task);
  if (isJsonRecord(value.message)) prepareMessageJsonForSdk(value.message);
  const statusUpdate = isJsonRecord(value.statusUpdate)
    ? value.statusUpdate
    : isJsonRecord(value.status_update)
      ? value.status_update
      : undefined;
  if (
    statusUpdate &&
    isJsonRecord(statusUpdate.status) &&
    isJsonRecord(statusUpdate.status.message)
  ) {
    prepareMessageJsonForSdk(statusUpdate.status.message);
  }
  const artifactUpdate = isJsonRecord(value.artifactUpdate)
    ? value.artifactUpdate
    : isJsonRecord(value.artifact_update)
      ? value.artifact_update
      : undefined;
  if (artifactUpdate && isJsonRecord(artifactUpdate.artifact)) {
    prepareArtifactJsonForSdk(artifactUpdate.artifact);
  }

  const response = StreamResponse.fromJSON(value);
  const payload = response.payload;
  if (payload?.$case === "task") restoreTaskDataNull(payload.value);
  if (payload?.$case === "message") restoreMessageDataNull(payload.value);
  if (payload?.$case === "statusUpdate" && payload.value.status?.message) {
    restoreMessageDataNull(payload.value.status.message);
  }
  if (payload?.$case === "artifactUpdate" && payload.value.artifact) {
    restoreArtifactDataNull(payload.value.artifact);
  }
  return response;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(task: Task): boolean {
  return task.status?.state !== undefined && isTerminalState(task.status.state);
}

function isTerminalState(state: number): boolean {
  return TERMINAL_STATES.has(state);
}

function assertPositiveTurn(turn: number, operation: string): void {
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    throw new Error(`${operation} turn must be a positive safe integer.`);
  }
}

export interface TaskPageCursor {
  id: string;
  statusTimestamp: string;
}

export function taskListFilterKey(params: ListTasksRequest): string {
  return JSON.stringify([
    params.contextId,
    params.status,
    params.statusTimestampAfter ?? ""
  ]);
}

/** Encodes the last returned ordering pair and its filters as an opaque token. */
export function encodeTaskPageToken(
  cursor: TaskPageCursor,
  params: ListTasksRequest
): string {
  return encodePageToken(cursor, taskListFilterKey(params));
}

function encodePageToken(cursor: TaskPageCursor, filter: string): string {
  const bytes = textEncoder.encode(
    JSON.stringify({
      version: 3,
      statusTimestamp: cursor.statusTimestamp,
      id: cursor.id,
      filter
    })
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Decodes and validates a filtered `(status_timestamp, id)` cursor. */
function decodePageToken(
  token: string,
  filter: string
): TaskPageCursor | undefined {
  if (!token) return undefined;
  try {
    const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    const value = JSON.parse(textDecoder.decode(bytes)) as Record<
      string,
      unknown
    >;
    if (
      value.version !== 3 ||
      typeof value.statusTimestamp !== "string" ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.filter !== filter
    ) {
      throw new Error("invalid");
    }
    return { id: value.id, statusTimestamp: value.statusTimestamp as string };
  } catch {
    throw new RequestMalformedError("Invalid page token.");
  }
}

export function serializedListResponseByteLength(
  tasks: Task[],
  nextPageToken: string,
  pageSize: number,
  totalSize: number
): number {
  const serializedTasksBytes = tasks.reduce(
    (total, task) => total + serializedTaskByteLength(task),
    0
  );
  return serializedListResponseByteLengthFromTaskBytes(
    serializedTasksBytes,
    tasks.length,
    nextPageToken,
    pageSize,
    totalSize
  );
}

function serializedListResponseByteLengthFromTaskBytes(
  serializedTasksBytes: number,
  taskCount: number,
  nextPageToken: string,
  pageSize: number,
  totalSize: number
): number {
  if (taskCount === 0) {
    const emptyData = JSON.stringify(
      ListTasksResponse.toJSON({
        tasks: [],
        nextPageToken,
        pageSize,
        totalSize
      })
    );
    return (
      textEncoder.encode(emptyData).byteLength +
      LIST_RESPONSE_ENVELOPE_RESERVE_BYTES
    );
  }
  const data = JSON.stringify(
    ListTasksResponse.toJSON({
      tasks: [LIST_TASK_SIZE_PLACEHOLDER],
      nextPageToken,
      pageSize,
      totalSize
    })
  );
  return (
    textEncoder.encode(data).byteLength +
    serializedTasksBytes -
    LIST_TASK_SIZE_PLACEHOLDER_BYTES +
    Math.max(0, taskCount - 1) +
    LIST_RESPONSE_ENVELOPE_RESERVE_BYTES
  );
}
