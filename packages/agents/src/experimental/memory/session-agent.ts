/**
 * @experimental SessionAgent — unstable API, may change without notice.
 *
 * A subclass of Agent that adds session and event management.
 * Tables are created in the constructor (guaranteed to run).
 *
 * SQL-bound methods (loadEvents, appendEvents, etc.) are callable via RPC
 * from Workflows and Workers. WorkingContext helpers are protected
 * (local only) because class instances don't survive RPC serialization.
 *
 * @example Inside the Agent
 * ```ts
 * class MyAgent extends SessionAgent<Env> {
 *   async handleMessage(sessionId: string, msg: string) {
 *     const ctx = this._buildWorkingContext(sessionId, { limit: 10 });
 *     ctx.addMessage({ role: 'user', content: msg });
 *     // ... call LLM, accumulate messages ...
 *     this.persistWorkingContext(sessionId, ctx);
 *   }
 * }
 * ```
 *
 * @example From a Workflow (via RPC)
 * ```ts
 * const agent = getAgentByName(env.MY_AGENT, "id");
 * const events = await agent.loadEvents(sessionId, { limit: 10 });
 * const ctx = buildWorkingContext(events, { systemInstructions: [...] });
 * // ... call LLM locally ...
 * await agent.appendEvents(sessionId, ctx.getNewEvents());
 * ```
 */

import { Agent, type AgentContext } from "../../index";
import type {
  ContextBuilderOptions,
  LoadEventsOptions,
  SessionEvent,
  StoredEvent,
  StoredSession
} from "./types";
import { hydrateEvent, dehydrateEvent, messageToEvent } from "./utils";
import { buildWorkingContext, type WorkingContext } from "./context";

const DEFAULT_LOAD_LIMIT = 50;

/**
 * @experimental
 */
export class SessionAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_events (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        action TEXT NOT NULL,
        content TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_events_session_seq
        ON cf_agents_events(session_id, seq)
    `;
  }

  // -----------------------------------------------------------------------
  // Session CRUD (safe for RPC — returns plain serializable objects)
  // -----------------------------------------------------------------------

  /**
   * @experimental
   * Create a new session. Returns the session ID.
   */
  createSession(metadata?: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const agentId = this.name;
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    this.sql`
      INSERT INTO cf_agents_sessions (id, agent_id, created_at, updated_at, metadata)
      VALUES (${id}, ${agentId}, ${now}, ${now}, ${metaJson})
    `;

    return id;
  }

  /**
   * @experimental
   * Get a session by ID. Returns null if not found.
   */
  getSession(sessionId: string): StoredSession | null {
    const rows = this.sql<StoredSession>`
      SELECT id, agent_id, created_at, updated_at, metadata
      FROM cf_agents_sessions
      WHERE id = ${sessionId}
    `;
    return rows[0] ?? null;
  }

  /**
   * @experimental
   * List all sessions for this agent, ordered by most recently updated.
   */
  listSessions(): StoredSession[] {
    return this.sql<StoredSession>`
      SELECT id, agent_id, created_at, updated_at, metadata
      FROM cf_agents_sessions
      WHERE agent_id = ${this.name}
      ORDER BY updated_at DESC
    `;
  }

  /**
   * @experimental
   * Delete a session and all its events.
   */
  deleteSession(sessionId: string): void {
    this.sql`DELETE FROM cf_agents_events WHERE session_id = ${sessionId}`;
    this.sql`DELETE FROM cf_agents_sessions WHERE id = ${sessionId}`;
  }

  // -----------------------------------------------------------------------
  // Event operations (safe for RPC)
  // -----------------------------------------------------------------------

  /**
   * @experimental
   * Load events for a session. Returns hydrated SessionEvent objects.
   * Results are always returned in `seq ASC` (insertion order).
   *
   * By default, loads the **last** N events (`tail: true`). This is the
   * correct behavior for context-building where you want the most recent
   * conversation. Set `tail: false` to load the first N events (useful
   * for replay or export).
   *
   * Default limit is 50. Pass a higher limit or use `since` for larger windows.
   */
  loadEvents(sessionId: string, opts: LoadEventsOptions = {}): SessionEvent[] {
    const limit = opts.limit ?? DEFAULT_LOAD_LIMIT;
    const since = opts.since ?? null;
    const actions = opts.actions ?? null;
    const tail = opts.tail ?? true;

    // Build WHERE clause dynamically to avoid combinatorial branching.
    const conditions = ["session_id = ?"];
    const params: unknown[] = [sessionId];

    if (since !== null) {
      conditions.push("created_at >= ?");
      params.push(since);
    }
    if (actions !== null && actions.length > 0) {
      conditions.push(`action IN (${actions.map(() => "?").join(", ")})`);
      params.push(...actions);
    }

    const where = conditions.join(" AND ");
    const innerOrder = tail ? "DESC" : "ASC";
    const inner = `SELECT id, session_id, seq, action, content, metadata, created_at FROM cf_agents_events WHERE ${where} ORDER BY seq ${innerOrder} LIMIT ?`;
    params.push(limit);

    // For tail mode, wrap in a subquery to restore ASC order.
    const query = tail
      ? `SELECT * FROM (${inner}) sub ORDER BY seq ASC`
      : inner;

    const rows = [
      ...this.ctx.storage.sql.exec(query, ...params)
    ] as unknown as StoredEvent[];

    return rows.map(hydrateEvent);
  }

  /**
   * @experimental
   * Append events to a session. Assigns monotonically increasing `seq` values.
   * Validates that the session exists before inserting.
   */
  appendEvents(sessionId: string, events: SessionEvent[]): void {
    if (events.length === 0) return;

    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Wrap batch insert in a transaction to prevent partial data on failure.
    this.ctx.storage.sql.exec("BEGIN");
    try {
      // Get the current max seq for this session
      const maxSeqRows = this.sql<{ max_seq: number | null }>`
        SELECT MAX(seq) as max_seq FROM cf_agents_events WHERE session_id = ${sessionId}
      `;
      let nextSeq = (maxSeqRows[0]?.max_seq ?? -1) + 1;

      for (const event of events) {
        // Override seq with the correct monotonic value
        const withSeq: SessionEvent = { ...event, seq: nextSeq, sessionId };
        const row = dehydrateEvent(withSeq);

        this.sql`
          INSERT INTO cf_agents_events (id, session_id, seq, action, content, metadata, created_at)
          VALUES (${row.id}, ${row.session_id}, ${row.seq}, ${row.action}, ${row.content}, ${row.metadata}, ${row.created_at})
        `;

        nextSeq++;
      }

      // Touch the session's updated_at
      this.sql`
        UPDATE cf_agents_sessions SET updated_at = ${Date.now()} WHERE id = ${sessionId}
      `;

      this.ctx.storage.sql.exec("COMMIT");
    } catch (e) {
      this.ctx.storage.sql.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * @experimental
   * Delete specific events by ID.
   */
  deleteEvents(sessionId: string, eventIds: string[]): void {
    if (eventIds.length === 0) return;

    for (const eventId of eventIds) {
      this.sql`
        DELETE FROM cf_agents_events WHERE id = ${eventId} AND session_id = ${sessionId}
      `;
    }
  }

  // -----------------------------------------------------------------------
  // WorkingContext helpers (local use ONLY — NOT for RPC)
  // -----------------------------------------------------------------------

  /**
   * @experimental
   * Build a WorkingContext by loading events from SQL and converting them.
   *
   * **Local use only** — do NOT call via RPC. The returned WorkingContext is a
   * class instance; its methods (`addMessage`, `getNewMessages`) are lost when
   * serialized over the RPC boundary. Workflows/Workers should use
   * `loadEvents()` via RPC + `buildWorkingContext()` pure function locally.
   */
  protected _buildWorkingContext(
    sessionId: string,
    opts: ContextBuilderOptions = {}
  ): WorkingContext {
    const events = this.loadEvents(sessionId, {
      limit: opts.limit,
      since: opts.since,
      actions: opts.actions,
      tail: opts.tail
    });

    return buildWorkingContext(events, opts);
  }

  /**
   * @experimental
   * Persist the new messages from a WorkingContext as events in the session store.
   * Only messages added after the initial build are persisted.
   */
  persistWorkingContext(sessionId: string, ctx: WorkingContext): void {
    const newMessages = ctx.getNewMessages();
    if (newMessages.length === 0) return;

    const events = newMessages.map((msg) => messageToEvent(sessionId, msg));
    this.appendEvents(sessionId, events);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * @experimental
   * Destroy the agent, cleaning up session tables before calling super.
   */
  async destroy() {
    this.sql`DROP TABLE IF EXISTS cf_agents_events`;
    this.sql`DROP TABLE IF EXISTS cf_agents_sessions`;
    await super.destroy();
  }
}
