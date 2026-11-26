import { routeAgentRequest } from "agents";
import {
  Assistant as ProductionAssistant,
  Planner,
  Researcher
} from "../server";

/** The agent's parent side of agent tools (an internal module). */
function agentToolsOf(agent: unknown): unknown {
  return (agent as { _agentTools: unknown })._agentTools;
}

type ToolRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "interrupted";

interface SeedRunArgs {
  runId: string;
  parentToolCallId?: string;
  agentType?: "Researcher" | "Planner";
  inputPreview?: unknown;
  status?: ToolRunStatus;
  displayOrder?: number;
  summary?: string | null;
  errorMessage?: string | null;
}

interface ToolRunRow {
  run_id: string;
  parent_tool_call_id: string | null;
  agent_type: string;
  status: ToolRunStatus;
  summary: string | null;
  error_message: string | null;
  display_order: number;
}

/**
 * The `cf_agent_tool_runs` table a released version kept, for tests that
 * seed its rows; the next start carries them into Task runs.
 */
function ensureReleasedAgentToolTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agent_tool_runs (
      run_id TEXT PRIMARY KEY, parent_tool_call_id TEXT,
      agent_type TEXT NOT NULL, input_preview TEXT,
      input_redacted INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
      summary TEXT, output_json TEXT, error_message TEXT,
      interrupted_reason TEXT, child_still_running INTEGER,
      display_metadata TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, completed_at INTEGER,
      detached INTEGER NOT NULL DEFAULT 0, detached_on_finish TEXT,
      detached_notify_source TEXT, detached_max_budget_at INTEGER,
      finish_claimed_at INTEGER, finish_delivered_at INTEGER,
      give_up_claimed_at INTEGER, give_up_delivered_at INTEGER,
      detached_no_progress_budget_ms INTEGER, last_progress_at INTEGER,
      detached_on_milestones TEXT, event_delivery TEXT
    )
  `);
}

export class Assistant extends ProductionAssistant {
  async testSeedAgentToolRun(args: SeedRunArgs): Promise<void> {
    const status = args.status ?? "completed";
    const now = Date.now();
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id,
        parent_tool_call_id,
        agent_type,
        input_preview,
        display_metadata,
        display_order,
        status,
        summary,
        error_message,
        started_at,
        completed_at
      )
      VALUES (
        ${args.runId},
        ${args.parentToolCallId ?? null},
        ${args.agentType ?? "Researcher"},
        ${JSON.stringify(args.inputPreview ?? "seeded topic")},
        ${JSON.stringify({ name: args.agentType ?? "Researcher" })},
        ${args.displayOrder ?? 0},
        ${status},
        ${args.summary ?? null},
        ${args.errorMessage ?? null},
        ${now},
        ${status === "starting" || status === "running" ? null : now}
      )
    `;
    // What the next start does with a released row: carry it into its run.
    await (
      agentToolsOf(this) as { _carryForwardAgentToolRuns(): Promise<void> }
    )._carryForwardAgentToolRuns();
  }

  async testReadAgentToolRuns(): Promise<ToolRunRow[]> {
    return (agentToolsOf(this) as { _listAgentToolRuns(): ToolRunRow[] })
      ._listAgentToolRuns()
      .map((row) => ({
        run_id: row.run_id,
        parent_tool_call_id: row.parent_tool_call_id,
        agent_type: row.agent_type,
        status: row.status,
        summary: row.summary,
        error_message: row.error_message,
        display_order: row.display_order
      }));
  }

  testHasAgentToolRun(agentType: string, runId: string): boolean {
    return this.hasAgentToolRun(agentType, runId);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

export { Planner, Researcher };
