/**
 * KernelStore — the durable tables the harness can never rewrite.
 *
 * - exo_journal: append-only event log. The kernel exposes no update or
 *   delete path, and harness code only ever receives an append capability.
 * - exo_versions: one row per activated harness version, including a full
 *   snapshot of /harness file contents so any version can be restored
 *   (rollback) or inspected (UI diffs) without touching git history.
 */

import type { JournalEntry, JournalKind, VersionInfo } from "./types";

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

interface VersionRow {
  version: number;
  sha: string;
  note: string;
  ts: number;
  files: string;
}

export class KernelStore {
  #sql: SqlTag;

  constructor(sql: SqlTag) {
    this.#sql = sql;
    this.#sql`
      CREATE TABLE IF NOT EXISTS exo_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `;
    this.#sql`
      CREATE TABLE IF NOT EXISTS exo_versions (
        version INTEGER PRIMARY KEY,
        sha TEXT NOT NULL,
        note TEXT NOT NULL,
        ts INTEGER NOT NULL,
        files TEXT NOT NULL
      )
    `;
  }

  appendJournal(kind: JournalKind, data: Record<string, unknown>): number {
    this.#sql`
      INSERT INTO exo_journal (ts, kind, data)
      VALUES (${Date.now()}, ${kind}, ${JSON.stringify(data)})
    `;
    const rows = this.#sql<{ id: number }>`
      SELECT last_insert_rowid() AS id
    `;
    return rows[0]?.id ?? 0;
  }

  /** Most recent entries first-to-last (ascending id), capped at `limit`. */
  journalTail(limit: number): JournalEntry[] {
    const rows = this.#sql<JournalRow>`
      SELECT id, ts, kind, data FROM exo_journal
      ORDER BY id DESC LIMIT ${limit}
    `;
    return rows.reverse().map(parseJournalRow);
  }

  /** Page backwards through history: entries with id < beforeId. */
  journalBefore(beforeId: number, limit: number): JournalEntry[] {
    const rows = this.#sql<JournalRow>`
      SELECT id, ts, kind, data FROM exo_journal
      WHERE id < ${beforeId}
      ORDER BY id DESC LIMIT ${limit}
    `;
    return rows.reverse().map(parseJournalRow);
  }

  journalCount(): number {
    const rows = this.#sql<{ n: number }>`
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
    this.#sql`
      INSERT INTO exo_versions (version, sha, note, ts, files)
      VALUES (${next}, ${sha}, ${note}, ${ts}, ${JSON.stringify(files)})
    `;
    return { version: next, sha, note, ts };
  }

  activeVersion(): number {
    const rows = this.#sql<{ v: number | null }>`
      SELECT MAX(version) AS v FROM exo_versions
    `;
    return rows[0]?.v ?? 0;
  }

  listVersions(): VersionInfo[] {
    const rows = this.#sql<Omit<VersionRow, "files">>`
      SELECT version, sha, note, ts FROM exo_versions ORDER BY version ASC
    `;
    return rows.map((r) => ({
      version: r.version,
      sha: r.sha,
      note: r.note,
      ts: r.ts
    }));
  }

  versionFiles(version: number): Record<string, string> | null {
    const rows = this.#sql<{ files: string }>`
      SELECT files FROM exo_versions WHERE version = ${version}
    `;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].files) as Record<string, string>;
  }

  versionInfo(version: number): VersionInfo | null {
    const rows = this.#sql<Omit<VersionRow, "files">>`
      SELECT version, sha, note, ts FROM exo_versions
      WHERE version = ${version}
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return { version: r.version, sha: r.sha, note: r.note, ts: r.ts };
  }
}

function parseJournalRow(row: JournalRow): JournalEntry {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
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
