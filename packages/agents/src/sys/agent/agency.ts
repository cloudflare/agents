import { Agent, getAgentByName, type AgentContext } from "../..";
import { parseCronExpression } from "cron-schedule";
import type {
  AgentBlueprint,
  ThreadMetadata,
  ThreadRequestContext,
  AgentEnv
} from "../types";

// ============================================================
// Schedule Types
// ============================================================

export type AgentScheduleType = "once" | "cron" | "interval";
export type OverlapPolicy = "skip" | "queue" | "allow";
export type ScheduleStatus = "active" | "paused" | "disabled";
export type ScheduleRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface AgentSchedule {
  id: string;
  name: string;
  agentType: string;
  input?: Record<string, unknown>; // Input/context to pass to the agent

  // Timing
  type: AgentScheduleType;
  runAt?: string; // ISO datetime for one-time
  cron?: string; // Cron expression
  intervalMs?: number; // Interval in milliseconds

  // Behavior
  status: ScheduleStatus;
  timezone?: string;
  maxRetries?: number;
  timeoutMs?: number;
  overlapPolicy: OverlapPolicy;

  // Metadata
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  agentId?: string; // The spawned agent instance
  status: ScheduleRunStatus;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: string;
  retryCount: number;
}

export interface CreateScheduleRequest {
  name: string;
  agentType: string;
  input?: Record<string, unknown>;
  type: AgentScheduleType;
  runAt?: string;
  cron?: string;
  intervalMs?: number;
  timezone?: string;
  maxRetries?: number;
  timeoutMs?: number;
  overlapPolicy?: OverlapPolicy;
}

function validateBlueprint(bp: AgentBlueprint): string | null {
  if (!bp.name || !/^[a-zA-Z0-9_-]+$/.test(bp.name)) {
    return "Blueprint name must be alphanumeric with - or _";
  }
  if (!bp.prompt || typeof bp.prompt !== "string") {
    return "Blueprint must have a prompt";
  }
  return null;
}

function validateSchedule(req: CreateScheduleRequest): string | null {
  if (!req.name || typeof req.name !== "string") {
    return "Schedule must have a name";
  }
  if (!req.agentType || typeof req.agentType !== "string") {
    return "Schedule must have an agentType";
  }
  if (!req.type || !["once", "cron", "interval"].includes(req.type)) {
    return "Schedule type must be 'once', 'cron', or 'interval'";
  }
  if (req.type === "once" && !req.runAt) {
    return "One-time schedule must have runAt";
  }
  if (req.type === "cron" && !req.cron) {
    return "Cron schedule must have cron expression";
  }
  if (req.type === "interval" && !req.intervalMs) {
    return "Interval schedule must have intervalMs";
  }
  return null;
}

const AGENCY_NAME_KEY = "_agency_name";

export class Agency extends Agent<AgentEnv> {
  private _cachedAgencyName: string | null = null;

  /**
   * Get the agency name. Prefers in-memory name (set via getAgentByName),
   * falls back to persisted name (for alarm wake-ups), then to DO ID.
   */
  get agencyName(): string {
    // 1. In-memory name from getAgentByName
    if (this.name) {
      // Persist it if not already done
      this.persistName(this.name);
      return this.name;
    }

    // 2. Cached from previous lookup
    if (this._cachedAgencyName) {
      return this._cachedAgencyName;
    }

    // 3. Read from KV storage
    const stored = this.ctx.storage.kv.get<string>(AGENCY_NAME_KEY);
    if (stored) {
      this._cachedAgencyName = stored;
      return stored;
    }

    throw new Error("Agency name not found");
  }

  private persistName(name: string): void {
    if (this._cachedAgencyName === name) return;
    this._cachedAgencyName = name;
    this.ctx.storage.kv.put(AGENCY_NAME_KEY, name);
  }

  constructor(ctx: AgentContext, env: AgentEnv) {
    super(ctx, env);

    // Initialize tables
    this.sql`
      CREATE TABLE IF NOT EXISTS blueprints (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS agent_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        input TEXT,
        type TEXT NOT NULL CHECK(type IN ('once', 'cron', 'interval')),
        run_at TEXT,
        cron TEXT,
        interval_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'disabled')),
        timezone TEXT,
        max_retries INTEGER DEFAULT 3,
        timeout_ms INTEGER,
        overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK(overlap_policy IN ('skip', 'queue', 'allow')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        scheduled_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        result TEXT,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY (schedule_id) REFERENCES agent_schedules(id) ON DELETE CASCADE
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON schedule_runs(schedule_id)
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agent_schedules_next_run ON agent_schedules(next_run_at) WHERE status = 'active'
    `;
  }

  // ============================================================
  // HTTP Request Handler
  // ============================================================

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // --------------------------------------------------
    // Blueprints Management
    // --------------------------------------------------

    if (req.method === "GET" && path === "/blueprints") {
      return Response.json({ blueprints: this.listDbBlueprints() });
    }

    if (req.method === "POST" && path === "/blueprints") {
      return this.handleCreateBlueprint(req);
    }

    // --------------------------------------------------
    // Agent Management
    // --------------------------------------------------

    if (req.method === "GET" && path === "/agents") {
      return this.handleListAgents();
    }

    if (req.method === "POST" && path === "/agents") {
      return this.handleCreateAgent(req);
    }

    // --------------------------------------------------
    // Schedule Management
    // --------------------------------------------------

    if (req.method === "GET" && path === "/schedules") {
      return this.handleListSchedules();
    }

    if (req.method === "POST" && path === "/schedules") {
      return this.handleCreateSchedule(req);
    }

    const scheduleMatch = path.match(/^\/schedules\/([^/]+)(\/.*)?$/);
    if (scheduleMatch) {
      const scheduleId = scheduleMatch[1];
      const action = scheduleMatch[2] || "";

      if (req.method === "GET" && action === "") {
        return this.handleGetSchedule(scheduleId);
      }
      if (req.method === "PATCH" && action === "") {
        return this.handleUpdateSchedule(scheduleId, req);
      }
      if (req.method === "DELETE" && action === "") {
        return this.handleDeleteSchedule(scheduleId);
      }
      if (req.method === "POST" && action === "/pause") {
        return this.handlePauseSchedule(scheduleId);
      }
      if (req.method === "POST" && action === "/resume") {
        return this.handleResumeSchedule(scheduleId);
      }
      if (req.method === "POST" && action === "/trigger") {
        return this.handleTriggerSchedule(scheduleId);
      }
      if (req.method === "GET" && action === "/runs") {
        return this.handleGetScheduleRuns(scheduleId);
      }
    }

    // --------------------------------------------------
    // Filesystem
    // --------------------------------------------------

    if (path.startsWith("/fs")) {
      return this.handleFilesystem(req, path);
    }

    // --------------------------------------------------
    // Internal: Blueprint lookup for child agents
    // --------------------------------------------------

    const matchBp = path.match(/^\/internal\/blueprint\/([^/]+)$/);
    if (req.method === "GET" && matchBp) {
      const name = matchBp[1];
      const rows = this.sql<{ data: string }>`
        SELECT data FROM blueprints WHERE name = ${name}
      `;
      if (rows.length > 0) {
        return Response.json(JSON.parse(rows[0].data));
      }
      return new Response(null, { status: 404 });
    }

    return new Response("Agency endpoint not found", { status: 404 });
  }

  // ============================================================
  // Blueprint Handlers
  // ============================================================

  listDbBlueprints(): AgentBlueprint[] {
    const rows = this.sql<{ data: string }>`SELECT data FROM blueprints`;
    return rows.map((r) => JSON.parse(r.data));
  }

  private async handleCreateBlueprint(req: Request): Promise<Response> {
    const bp = (await req.json()) as AgentBlueprint;
    if (!bp.name) return new Response("Missing name", { status: 400 });

    const now = new Date().toISOString();
    const existing = this.sql<{ data: string }>`
      SELECT data FROM blueprints WHERE name = ${bp.name}
    `;

    let merged = { ...bp };
    if (existing.length > 0) {
      const prev = JSON.parse(existing[0].data);
      merged = {
        ...prev,
        ...bp,
        createdAt: prev.createdAt ?? now,
        updatedAt: now
      };
    } else {
      merged = {
        ...bp,
        status: bp.status ?? "active",
        createdAt: now,
        updatedAt: now
      };
    }

    const err = validateBlueprint(merged);
    if (err) return new Response(err, { status: 400 });

    this.sql`
      INSERT OR REPLACE INTO blueprints (name, data, updated_at)
      VALUES (${merged.name}, ${JSON.stringify(merged)}, ${Date.now()})
    `;

    return Response.json({ ok: true, name: merged.name });
  }

  // ============================================================
  // Agent Handlers
  // ============================================================

  private handleListAgents(): Response {
    const rows = this.sql<{
      id: string;
      type: string;
      created_at: number;
      metadata: string;
    }>`SELECT * FROM agents ORDER BY created_at DESC`;

    const agents = rows.map((r) => ({
      id: r.id,
      agentType: r.type,
      createdAt: new Date(r.created_at).toISOString(),
      ...JSON.parse(r.metadata || "{}")
    }));

    return Response.json({ agents });
  }

  private async handleCreateAgent(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      agentType: string;
      requestContext?: ThreadRequestContext;
      input?: Record<string, unknown>;
    };

    return this.spawnAgent(body.agentType, body.requestContext, body.input);
  }

  async spawnAgent(
    agentType: string,
    requestContext?: ThreadRequestContext,
    input?: Record<string, unknown>
  ): Promise<Response> {
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    const meta = {
      request: requestContext,
      agencyId: this.agencyName,
      input
    };

    this.sql`
      INSERT INTO agents (id, type, created_at, metadata)
      VALUES (${id}, ${agentType}, ${createdAt}, ${JSON.stringify(meta)})
    `;

    const stub = await getAgentByName(this.env.SYSTEM_AGENT, id);

    const initPayload: ThreadMetadata = {
      id,
      createdAt: new Date(createdAt).toISOString(),
      agentType,
      request: requestContext ?? {},
      parent: undefined,
      agencyId: this.agencyName
    };

    const res = await stub.fetch(
      new Request("http://do/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(initPayload)
      })
    );

    if (!res.ok) {
      this.sql`DELETE FROM agents WHERE id = ${id}`;
      return res;
    }

    // If input provided, auto-invoke the agent
    if (input) {
      const userMessage =
        typeof input.message === "string"
          ? input.message
          : JSON.stringify(input);

      await stub.fetch(
        new Request("http://do/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: userMessage }]
          })
        })
      );
    }

    return Response.json(initPayload, { status: 201 });
  }

  // ============================================================
  // Schedule Handlers
  // ============================================================

  private handleListSchedules(): Response {
    const rows = this.sql<AgentScheduleRow>`
      SELECT * FROM agent_schedules ORDER BY created_at DESC
    `;
    return Response.json({ schedules: rows.map(rowToSchedule) });
  }

  private async handleCreateSchedule(req: Request): Promise<Response> {
    const body = (await req.json()) as CreateScheduleRequest;

    const err = validateSchedule(body);
    if (err) return new Response(err, { status: 400 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const nextRunAt = this.computeNextRun(body);

    this.sql`
      INSERT INTO agent_schedules (
        id, name, agent_type, input, type, run_at, cron, interval_ms,
        status, timezone, max_retries, timeout_ms, overlap_policy,
        created_at, updated_at, next_run_at
      ) VALUES (
        ${id},
        ${body.name},
        ${body.agentType},
        ${body.input ? JSON.stringify(body.input) : null},
        ${body.type},
        ${body.runAt || null},
        ${body.cron || null},
        ${body.intervalMs || null},
        ${"active"},
        ${body.timezone || null},
        ${body.maxRetries ?? 3},
        ${body.timeoutMs || null},
        ${body.overlapPolicy || "skip"},
        ${now},
        ${now},
        ${nextRunAt}
      )
    `;

    // Schedule the alarm using Agent's built-in scheduling
    if (nextRunAt) {
      await this.schedule(new Date(nextRunAt), "runScheduledAgent", { id });
    }

    const schedule = this.getScheduleById(id);
    return Response.json({ schedule }, { status: 201 });
  }

  private handleGetSchedule(id: string): Response {
    const schedule = this.getScheduleById(id);
    if (!schedule) {
      return new Response("Schedule not found", { status: 404 });
    }
    return Response.json({ schedule });
  }

  private async handleUpdateSchedule(
    id: string,
    req: Request
  ): Promise<Response> {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }

    const updates = (await req.json()) as Partial<CreateScheduleRequest>;
    const now = new Date().toISOString();

    // Build update fields
    const merged = { ...existing, ...updates, updatedAt: now };
    const nextRunAt =
      updates.type || updates.runAt || updates.cron || updates.intervalMs
        ? this.computeNextRun(merged)
        : existing.nextRunAt;

    this.sql`
      UPDATE agent_schedules SET
        name = ${merged.name},
        agent_type = ${merged.agentType},
        input = ${merged.input ? JSON.stringify(merged.input) : null},
        type = ${merged.type},
        run_at = ${merged.runAt || null},
        cron = ${merged.cron || null},
        interval_ms = ${merged.intervalMs || null},
        timezone = ${merged.timezone || null},
        max_retries = ${merged.maxRetries ?? 3},
        timeout_ms = ${merged.timeoutMs || null},
        overlap_policy = ${merged.overlapPolicy || "skip"},
        updated_at = ${now},
        next_run_at = ${nextRunAt || null}
      WHERE id = ${id}
    `;

    return Response.json({ schedule: this.getScheduleById(id) });
  }

  private handleDeleteSchedule(id: string): Response {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }

    this.sql`DELETE FROM agent_schedules WHERE id = ${id}`;
    this.sql`DELETE FROM schedule_runs WHERE schedule_id = ${id}`;

    return Response.json({ ok: true });
  }

  private handlePauseSchedule(id: string): Response {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }

    this.sql`
      UPDATE agent_schedules SET status = 'paused', updated_at = ${new Date().toISOString()}
      WHERE id = ${id}
    `;

    return Response.json({ schedule: this.getScheduleById(id) });
  }

  private async handleResumeSchedule(id: string): Promise<Response> {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }

    const now = new Date().toISOString();
    const nextRunAt = this.computeNextRun(existing);

    this.sql`
      UPDATE agent_schedules SET
        status = 'active',
        updated_at = ${now},
        next_run_at = ${nextRunAt || null}
      WHERE id = ${id}
    `;

    // Re-schedule alarm
    if (nextRunAt) {
      await this.schedule(new Date(nextRunAt), "runScheduledAgent", { id });
    }

    return Response.json({ schedule: this.getScheduleById(id) });
  }

  private async handleTriggerSchedule(id: string): Promise<Response> {
    const existing = this.getScheduleById(id);
    if (!existing) {
      return new Response("Schedule not found", { status: 404 });
    }

    // Manual trigger bypasses overlap policy
    const run = await this.executeSchedule(existing, true);
    return Response.json({ run });
  }

  private handleGetScheduleRuns(scheduleId: string): Response {
    const runs = this.sql<ScheduleRunRow>`
      SELECT * FROM schedule_runs
      WHERE schedule_id = ${scheduleId}
      ORDER BY scheduled_at DESC
      LIMIT 100
    `;
    return Response.json({ runs: runs.map(rowToRun) });
  }

  // ============================================================
  // Schedule Execution
  // ============================================================

  /**
   * Callback method invoked by Agent's alarm system
   */
  async runScheduledAgent(payload: { id: string }): Promise<void> {
    const schedule = this.getScheduleById(payload.id);
    if (!schedule) {
      console.warn(`Schedule ${payload.id} not found, skipping`);
      return;
    }

    if (schedule.status !== "active") {
      console.log(`Schedule ${payload.id} is ${schedule.status}, skipping`);
      return;
    }

    // Check overlap policy
    if (schedule.overlapPolicy === "skip") {
      const runningRuns = this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM schedule_runs
        WHERE schedule_id = ${schedule.id} AND status = 'running'
      `;
      if (runningRuns[0]?.count > 0) {
        console.log(
          `Schedule ${schedule.id} has running instance, skipping (overlap=skip)`
        );
        // Still schedule the next run
        await this.scheduleNextRun(schedule);
        return;
      }
    }

    await this.executeSchedule(schedule, false);
    await this.scheduleNextRun(schedule);
  }

  private async executeSchedule(
    schedule: AgentSchedule,
    isManual: boolean
  ): Promise<ScheduleRun> {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create run record
    this.sql`
      INSERT INTO schedule_runs (id, schedule_id, status, scheduled_at, started_at, retry_count)
      VALUES (${runId}, ${schedule.id}, 'running', ${now}, ${now}, ${0})
    `;

    // Update schedule last_run_at
    this.sql`
      UPDATE agent_schedules SET last_run_at = ${now} WHERE id = ${schedule.id}
    `;

    try {
      // Spawn the agent
      const res = await this.spawnAgent(
        schedule.agentType,
        undefined,
        schedule.input
      );

      if (!res.ok) {
        throw new Error(`Failed to spawn agent: ${res.status}`);
      }

      const agentData = (await res.json()) as { id: string };

      // Update run with agent ID
      this.sql`
        UPDATE schedule_runs SET
          agent_id = ${agentData.id},
          status = 'completed',
          completed_at = ${new Date().toISOString()}
        WHERE id = ${runId}
      `;

      return this.getRunById(runId)!;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.sql`
        UPDATE schedule_runs SET
          status = 'failed',
          completed_at = ${new Date().toISOString()},
          error = ${errorMsg}
        WHERE id = ${runId}
      `;

      // TODO: Implement retry logic based on schedule.maxRetries
      console.error(`Schedule ${schedule.id} execution failed:`, errorMsg);

      return this.getRunById(runId)!;
    }
  }

  private async scheduleNextRun(schedule: AgentSchedule): Promise<void> {
    // Only schedule next for recurring types
    if (schedule.type === "once") {
      // Disable one-time schedules after execution
      this.sql`
        UPDATE agent_schedules SET status = 'disabled' WHERE id = ${schedule.id}
      `;
      return;
    }

    const nextRunAt = this.computeNextRun(schedule);
    if (nextRunAt) {
      this.sql`
        UPDATE agent_schedules SET next_run_at = ${nextRunAt} WHERE id = ${schedule.id}
      `;
      await this.schedule(new Date(nextRunAt), "runScheduledAgent", {
        id: schedule.id
      });
    }
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  private getScheduleById(id: string): AgentSchedule | null {
    const rows = this.sql<AgentScheduleRow>`
      SELECT * FROM agent_schedules WHERE id = ${id}
    `;
    return rows.length > 0 ? rowToSchedule(rows[0]) : null;
  }

  private getRunById(id: string): ScheduleRun | null {
    const rows = this.sql<ScheduleRunRow>`
      SELECT * FROM schedule_runs WHERE id = ${id}
    `;
    return rows.length > 0 ? rowToRun(rows[0]) : null;
  }

  private computeNextRun(
    schedule: Pick<
      AgentSchedule,
      "type" | "runAt" | "cron" | "intervalMs" | "lastRunAt"
    >
  ): string | null {
    const now = new Date();

    switch (schedule.type) {
      case "once":
        if (schedule.runAt) {
          const runAt = new Date(schedule.runAt);
          return runAt > now ? schedule.runAt : null;
        }
        return null;

      case "cron":
        if (schedule.cron) {
          try {
            const interval = parseCronExpression(schedule.cron);
            return interval.getNextDate().toISOString();
          } catch (e) {
            console.error("Failed to parse cron expression:", e);
            return null;
          }
        }
        return null;

      case "interval":
        if (schedule.intervalMs) {
          const base = schedule.lastRunAt ? new Date(schedule.lastRunAt) : now;
          return new Date(base.getTime() + schedule.intervalMs).toISOString();
        }
        return null;

      default:
        return null;
    }
  }

  // ============================================================
  // Filesystem Handlers
  // ============================================================

  /**
   * Handle filesystem requests.
   * Routes:
   *   GET  /fs/...          - List directory or read file
   *   PUT  /fs/...          - Write file (body = content)
   *   DELETE /fs/...        - Delete file
   *
   * Paths map to R2: /fs/shared/... → {agencyId}/shared/...
   *                  /fs/agents/... → {agencyId}/agents/...
   */
  private async handleFilesystem(
    req: Request,
    path: string
  ): Promise<Response> {
    const bucket = this.env.FS;
    if (!bucket) {
      return new Response("Filesystem not configured (missing FS binding)", {
        status: 503
      });
    }

    // Extract the path after /fs
    // /fs → "", /fs/ → "", /fs/shared/foo → "shared/foo"
    let fsPath = path.slice(3); // remove "/fs"
    if (fsPath.startsWith("/")) fsPath = fsPath.slice(1);

    // Build R2 key: /{agencyId}/{fsPath}
    const r2Prefix = this.agencyName + "/";
    const r2Key = r2Prefix + fsPath;

    switch (req.method) {
      case "GET":
        return this.handleFsGet(bucket, r2Key, r2Prefix, fsPath);
      case "PUT":
        return this.handleFsPut(bucket, r2Key, fsPath, req);
      case "DELETE":
        return this.handleFsDelete(bucket, r2Key, fsPath);
      default:
        return new Response("Method not allowed", { status: 405 });
    }
  }

  private async handleFsGet(
    bucket: R2Bucket,
    r2Key: string,
    r2Prefix: string,
    fsPath: string
  ): Promise<Response> {
    // Check if it's a file first
    const obj = await bucket.get(r2Key);
    if (obj) {
      // It's a file - return contents
      const content = await obj.text();
      return new Response(content, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-fs-path": "/" + fsPath,
          "x-fs-size": String(obj.size),
          "x-fs-modified": obj.uploaded.toISOString()
        }
      });
    }

    // Not a file - list as directory
    const prefix = r2Key.endsWith("/") ? r2Key : r2Key + "/";
    const list = await bucket.list({ prefix, delimiter: "/" });

    type FSEntry = {
      type: "file" | "dir";
      path: string;
      size?: number;
      modified?: string;
    };

    const entries: FSEntry[] = [];

    // Add directories (delimited prefixes)
    for (const p of list.delimitedPrefixes) {
      const relPath = p.slice(r2Prefix.length);
      entries.push({ type: "dir", path: "/" + relPath });
    }

    // Add files
    for (const obj of list.objects) {
      // Skip the "directory marker" if key equals prefix
      if (obj.key === r2Key) continue;
      const relPath = obj.key.slice(r2Prefix.length);
      entries.push({
        type: "file",
        path: "/" + relPath,
        size: obj.size,
        modified: obj.uploaded.toISOString()
      });
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return Response.json({
      path: "/" + fsPath || "/",
      entries
    });
  }

  private async handleFsPut(
    bucket: R2Bucket,
    r2Key: string,
    fsPath: string,
    req: Request
  ): Promise<Response> {
    if (!fsPath) {
      return new Response("Cannot write to root", { status: 400 });
    }

    const content = await req.text();
    await bucket.put(r2Key, content);

    return Response.json({
      ok: true,
      path: "/" + fsPath,
      size: content.length
    });
  }

  private async handleFsDelete(
    bucket: R2Bucket,
    r2Key: string,
    fsPath: string
  ): Promise<Response> {
    if (!fsPath) {
      return new Response("Cannot delete root", { status: 400 });
    }

    await bucket.delete(r2Key);

    return Response.json({
      ok: true,
      path: "/" + fsPath
    });
  }
}

// ============================================================
// Row Types & Converters
// ============================================================

type AgentScheduleRow = {
  id: string;
  name: string;
  agent_type: string;
  input: string | null;
  type: string;
  run_at: string | null;
  cron: string | null;
  interval_ms: number | null;
  status: string;
  timezone: string | null;
  max_retries: number;
  timeout_ms: number | null;
  overlap_policy: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
};

type ScheduleRunRow = {
  id: string;
  schedule_id: string;
  agent_id: string | null;
  status: string;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: string | null;
  retry_count: number;
};

function rowToSchedule(row: AgentScheduleRow): AgentSchedule {
  return {
    id: row.id,
    name: row.name,
    agentType: row.agent_type,
    input: row.input ? JSON.parse(row.input) : undefined,
    type: row.type as AgentScheduleType,
    runAt: row.run_at || undefined,
    cron: row.cron || undefined,
    intervalMs: row.interval_ms || undefined,
    status: row.status as ScheduleStatus,
    timezone: row.timezone || undefined,
    maxRetries: row.max_retries,
    timeoutMs: row.timeout_ms || undefined,
    overlapPolicy: row.overlap_policy as OverlapPolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at || undefined,
    nextRunAt: row.next_run_at || undefined
  };
}

function rowToRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    agentId: row.agent_id || undefined,
    status: row.status as ScheduleRunStatus,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    error: row.error || undefined,
    result: row.result || undefined,
    retryCount: row.retry_count
  };
}
