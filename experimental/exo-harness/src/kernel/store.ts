/**
 * KernelStore — the durable tables the harness can never rewrite.
 *
 * - exo_journal: append-only event log. The kernel exposes no update or
 *   delete path, and harness code only ever receives an append capability.
 * - exo_versions: one row per activated harness version, including a full
 *   snapshot of /harness file contents so any version can be restored
 *   (rollback) or inspected (UI diffs) without touching git history.
 */

import { MODEL_INVOCATION_BOUNDS } from "./types";
import type {
  ContextSnapshot,
  JournalEntry,
  JournalKind,
  JsonObject,
  PendingCompaction,
  TaskInfo,
  TaskState,
  VersionInfo
} from "./types";

export type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

interface JournalRow {
  id: number;
  ts: number;
  kind: string;
  data: string;
}

interface TaskRow {
  id: string;
  instruction: string;
  kind: string;
  spec: string;
  state: string;
  created_ts: number;
  last_run_ts: number | null;
  runs: number;
  consecutive_failures: number;
}

class ModelInvocationLimitReached extends Error {
  readonly _tag = "ModelInvocationLimitReached" as const;

  constructor(
    readonly limit: number,
    readonly windowMs: number
  ) {
    super(
      `Model invocation limit reached (${limit.toLocaleString("en-US")} in rolling 24 hours)`
    );
  }
}

interface VersionRow {
  version: number;
  sha: string;
  note: string;
  ts: number;
  files: string;
  remote: string | null;
  pushed_sha: string | null;
}

export class KernelStore {
  private readonly sql: SqlTag;

  constructor(sql: SqlTag) {
    this.sql = sql;
    this.sql`
      CREATE TABLE IF NOT EXISTS exo_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS exo_journal_kind_ts
      ON exo_journal (kind, ts)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS exo_versions (
        version INTEGER PRIMARY KEY,
        sha TEXT NOT NULL,
        note TEXT NOT NULL,
        ts INTEGER NOT NULL,
        files TEXT NOT NULL,
        remote TEXT,
        pushed_sha TEXT
      )
    `;
    // Ledgers created before the Artifacts integration lack the push columns.
    const columns = new Set(
      this.sql<{ name: string }>`
        SELECT name FROM pragma_table_info('exo_versions')
      `.map((c) => c.name)
    );
    if (!columns.has("remote")) {
      this.sql`ALTER TABLE exo_versions ADD COLUMN remote TEXT`;
    }
    if (!columns.has("pushed_sha")) {
      this.sql`ALTER TABLE exo_versions ADD COLUMN pushed_sha TEXT`;
    }
    // Single-row diagnostic snapshot of the last assembled model context.
    this.sql`
      CREATE TABLE IF NOT EXISTS exo_context (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ts INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `;
    // Single-row "compaction requested" flag, applied at next chat turn start.
    this.sql`
      CREATE TABLE IF NOT EXISTS exo_pending_compaction (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      )
    `;
    // Registry for self-scheduled tasks (id matches the SDK schedule id).
    this.sql`
      CREATE TABLE IF NOT EXISTS exo_tasks (
        id TEXT PRIMARY KEY,
        instruction TEXT NOT NULL,
        kind TEXT NOT NULL,
        spec TEXT NOT NULL,
        state TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        last_run_ts INTEGER,
        runs INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      )
    `;
  }

  insertTask(task: {
    id: string;
    instruction: string;
    kind: TaskInfo["kind"];
    spec: string;
  }): void {
    this.sql`
      INSERT INTO exo_tasks (id, instruction, kind, spec, state, created_ts)
      VALUES (${task.id}, ${task.instruction}, ${task.kind}, ${task.spec}, 'active', ${Date.now()})
    `;
  }

  taskById(id: string): TaskInfo | null {
    const rows = this.sql<TaskRow>`
      SELECT * FROM exo_tasks WHERE id = ${id}
    `;
    return rows.length > 0 ? toTaskInfo(rows[0]) : null;
  }

  listTasks(): TaskInfo[] {
    const rows = this.sql<TaskRow>`
      SELECT * FROM exo_tasks ORDER BY created_ts DESC
    `;
    return rows.map(toTaskInfo);
  }

  countActiveTasks(): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM exo_tasks WHERE state = 'active'
    `;
    return rows[0]?.n ?? 0;
  }

  setTaskState(id: string, state: TaskState): void {
    this.sql`UPDATE exo_tasks SET state = ${state} WHERE id = ${id}`;
  }

  /** Record a firing; resets or increments the consecutive-failure count. */
  recordTaskRun(id: string, ok: boolean): void {
    if (ok) {
      this.sql`
        UPDATE exo_tasks
        SET last_run_ts = ${Date.now()}, runs = runs + 1,
            consecutive_failures = 0
        WHERE id = ${id}
      `;
    } else {
      this.sql`
        UPDATE exo_tasks
        SET last_run_ts = ${Date.now()}, runs = runs + 1,
            consecutive_failures = consecutive_failures + 1
        WHERE id = ${id}
      `;
    }
  }

  /** Most recent firing across ALL tasks (global rate limit). */
  lastTaskRunTs(): number | null {
    const rows = this.sql<{ ts: number | null }>`
      SELECT MAX(last_run_ts) AS ts FROM exo_tasks
    `;
    return rows[0]?.ts ?? null;
  }

  /** Reserve a model step and record its non-sensitive diagnostic origin. */
  reserveModelInvocation(
    source: ContextSnapshot["source"],
    stepNumber: number
  ): ModelInvocationLimitReached | null {
    const now = Date.now();
    const count = this.journalCountSince(
      "model_invocation",
      now - MODEL_INVOCATION_BOUNDS.rollingWindowMs
    );
    if (count >= MODEL_INVOCATION_BOUNDS.maxPerRolling24Hours) {
      return new ModelInvocationLimitReached(
        MODEL_INVOCATION_BOUNDS.maxPerRolling24Hours,
        MODEL_INVOCATION_BOUNDS.rollingWindowMs
      );
    }
    this.appendJournal("model_invocation", { source, stepNumber });
    return null;
  }

  /** Journal entries of one kind since a timestamp (daily budget check). */
  journalCountSince(kind: JournalKind, sinceTs: number): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM exo_journal
      WHERE kind = ${kind} AND ts >= ${sinceTs}
    `;
    return rows[0]?.n ?? 0;
  }

  setPendingCompaction(pending: PendingCompaction): void {
    this.sql`
      INSERT INTO exo_pending_compaction (id, data)
      VALUES (1, ${JSON.stringify(pending)})
      ON CONFLICT (id) DO UPDATE SET data = excluded.data
    `;
  }

  /** Read and clear the pending compaction, if any. */
  takePendingCompaction(): PendingCompaction | null {
    const rows = this.sql<{ data: string }>`
      SELECT data FROM exo_pending_compaction WHERE id = 1
    `;
    if (rows.length === 0) return null;
    this.sql`DELETE FROM exo_pending_compaction WHERE id = 1`;
    try {
      return JSON.parse(rows[0].data) as PendingCompaction;
    } catch {
      return null;
    }
  }

  /** Overwrite the (single) last-turn context snapshot. */
  saveContextSnapshot(snapshot: ContextSnapshot): void {
    this.sql`
      INSERT INTO exo_context (id, ts, data)
      VALUES (1, ${snapshot.ts}, ${JSON.stringify(snapshot)})
      ON CONFLICT (id) DO UPDATE SET ts = excluded.ts, data = excluded.data
    `;
  }

  contextSnapshot(): ContextSnapshot | null {
    const rows = this.sql<{ data: string }>`
      SELECT data FROM exo_context WHERE id = 1
    `;
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].data) as ContextSnapshot;
    } catch {
      return null;
    }
  }

  appendJournal(kind: JournalKind, data: JsonObject): number {
    this.sql`
      INSERT INTO exo_journal (ts, kind, data)
      VALUES (${Date.now()}, ${kind}, ${JSON.stringify(data)})
    `;
    const rows = this.sql<{ id: number }>`
      SELECT last_insert_rowid() AS id
    `;
    return rows[0]?.id ?? 0;
  }

  /** Most recent entries first-to-last (ascending id), capped at `limit`. */
  journalTail(limit: number): JournalEntry[] {
    const rows = this.sql<JournalRow>`
      SELECT id, ts, kind, data FROM exo_journal
      ORDER BY id DESC LIMIT ${limit}
    `;
    return rows.reverse().map(parseJournalRow);
  }

  /** Page backwards through history: entries with id < beforeId. */
  journalBefore(beforeId: number, limit: number): JournalEntry[] {
    const rows = this.sql<JournalRow>`
      SELECT id, ts, kind, data FROM exo_journal
      WHERE id < ${beforeId}
      ORDER BY id DESC LIMIT ${limit}
    `;
    return rows.reverse().map(parseJournalRow);
  }

  journalCount(): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM exo_journal
    `;
    return rows[0]?.n ?? 0;
  }

  insertVersion(
    sha: string,
    note: string,
    files: Record<string, string>
  ): VersionInfo {
    const next = this.activeVersion() + 1;
    const ts = Date.now();
    this.sql`
      INSERT INTO exo_versions (version, sha, note, ts, files)
      VALUES (${next}, ${sha}, ${note}, ${ts}, ${JSON.stringify(files)})
    `;
    return { version: next, sha, note, ts, remote: null, pushedSha: null };
  }

  /** Record a confirmed Artifacts push against an existing version. */
  setVersionPush(version: number, remote: string, pushedSha: string): void {
    this.sql`
      UPDATE exo_versions
      SET remote = ${remote}, pushed_sha = ${pushedSha}
      WHERE version = ${version}
    `;
  }

  activeVersion(): number {
    const rows = this.sql<{ v: number | null }>`
      SELECT MAX(version) AS v FROM exo_versions
    `;
    return rows[0]?.v ?? 0;
  }

  listVersions(): VersionInfo[] {
    const rows = this.sql<Omit<VersionRow, "files">>`
      SELECT version, sha, note, ts, remote, pushed_sha
      FROM exo_versions ORDER BY version ASC
    `;
    return rows.map(toVersionInfo);
  }

  versionFiles(version: number): Record<string, string> | null {
    const rows = this.sql<{ files: string }>`
      SELECT files FROM exo_versions WHERE version = ${version}
    `;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].files) as Record<string, string>;
  }

  versionInfo(version: number): VersionInfo | null {
    const rows = this.sql<Omit<VersionRow, "files">>`
      SELECT version, sha, note, ts, remote, pushed_sha FROM exo_versions
      WHERE version = ${version}
    `;
    if (rows.length === 0) return null;
    return toVersionInfo(rows[0]);
  }
}

function toTaskInfo(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    instruction: row.instruction,
    kind: row.kind as TaskInfo["kind"],
    spec: row.spec,
    state: row.state as TaskState,
    createdTs: row.created_ts,
    lastRunTs: row.last_run_ts ?? null,
    runs: row.runs,
    consecutiveFailures: row.consecutive_failures,
    nextRunTs: null
  };
}

function toVersionInfo(row: Omit<VersionRow, "files">): VersionInfo {
  return {
    version: row.version,
    sha: row.sha,
    note: row.note,
    ts: row.ts,
    remote: row.remote ?? null,
    pushedSha: row.pushed_sha ?? null
  };
}

function parseJournalRow(row: JournalRow): JournalEntry {
  let data: JsonObject;
  try {
    data = JSON.parse(row.data) as JsonObject;
  } catch {
    data = { raw: row.data };
  }
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind as JournalEntry["kind"],
    data
  };
}
