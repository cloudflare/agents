/**
 * The durable turn engine's versioned SQLite schema. Every table is prefixed
 * `cf_channels_` so it can coexist with its host Durable Object's own storage.
 *
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cf_channels_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // The ledger. One row per turn; `state` is the source of truth recovery
  // reads. `next_seq` allocates journal positions;
  // `continuation_from_seq` marks a post-interaction continuation.
  `CREATE TABLE IF NOT EXISTS cf_channels_turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    source_event_id TEXT,
    origin TEXT NOT NULL,
    principal TEXT,
    state TEXT NOT NULL,
    outcome TEXT,
    error_text TEXT,
    input TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 0,
    continuation_from_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS cf_channels_turns_unsettled
    ON cf_channels_turns (state) WHERE state != 'settled'`,
  `CREATE INDEX IF NOT EXISTS cf_channels_turns_conversation
    ON cf_channels_turns (conversation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cf_channels_turns_source_event
    ON cf_channels_turns (conversation_id, source_event_id)
    WHERE source_event_id IS NOT NULL`,

  // Append-only connector output. Pruned for settled turns after retention.
  `CREATE TABLE IF NOT EXISTS cf_channels_turn_chunks (
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk TEXT NOT NULL,
    PRIMARY KEY (turn_id, seq)
  )`,

  // Pending human-in-the-loop waits and their completions.
  `CREATE TABLE IF NOT EXISTS cf_channels_interactions (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    value TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS cf_channels_interactions_turn
    ON cf_channels_interactions (turn_id)`,

  // Scoped per-conversation KV for connectors (session ids, offsets,
  // pending-submission records).
  `CREATE TABLE IF NOT EXISTS cf_channels_connector_state (
    conversation_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (conversation_id, key)
  )`
];
