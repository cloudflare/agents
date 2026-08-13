/**
 * Engine storage schema. One function owns every table (the pattern worth
 * keeping from Agent._ensureSchema). Prefix rb_ (rebuild).
 *
 * rb_entries is the Log — the only source of truth. rb_claims and
 * rb_consumers are projections/indexes with their own write paths; rb_branches
 * records fork lineage; rb_blobs stores bulk out of the log; rb_turns is
 * runtime bookkeeping (which turns are active/queued/parked), rebuilt-able
 * from turn/marker entries but kept as a table so admission stays O(1).
 */

import type { SqlDatabase } from "../substrate";

export function ensureSchema(db: SqlDatabase): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS rb_entries (
      branch TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE,
      at INTEGER NOT NULL,
      origin_module TEXT NOT NULL,
      origin_instance TEXT,
      turn TEXT,
      correlation TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (branch, seq)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS rb_entries_kind
      ON rb_entries(branch, kind, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS rb_entries_correlation
      ON rb_entries(branch, correlation, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS rb_entries_turn
      ON rb_entries(branch, turn, seq)`);

    db.exec(`CREATE TABLE IF NOT EXISTS rb_append_idempotency (
      key TEXT PRIMARY KEY,
      content_digest TEXT NOT NULL,
      refs_json TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS rb_branches (
      id TEXT PRIMARY KEY,
      parent_branch TEXT,
      fork_seq INTEGER,
      next_seq INTEGER NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS rb_claims (
      key TEXT PRIMARY KEY,
      effect TEXT NOT NULL,
      status TEXT NOT NULL, -- open | settled
      claim_entry_id TEXT NOT NULL,
      settle_entry_id TEXT,
      reconciler TEXT NOT NULL,
      reconcile_after_ms INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      next_check_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      turn TEXT,
      correlation TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS rb_claims_open
      ON rb_claims(status, next_check_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS rb_claims_correlation
      ON rb_claims(correlation)`);

    db.exec(`CREATE TABLE IF NOT EXISTS rb_consumers (
      name TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS rb_blobs (
      id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data BLOB NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS rb_turns (
      turn_id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      status TEXT NOT NULL, -- queued | active | parked | completed | failed
      attempt INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      queued_order INTEGER NOT NULL
    )`);
  });
}
