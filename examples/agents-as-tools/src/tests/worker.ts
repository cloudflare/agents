import { routeAgentRequest } from "agents";
import {
  Assistant as ProductionAssistant,
  Planner,
  Researcher
} from "../server";

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

export class Assistant extends ProductionAssistant {
  async testSeedAgentToolRun(args: SeedRunArgs): Promise<void> {
    const status = args.status ?? "completed";
    const now = Date.now();
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
  }

  async testReadAgentToolRuns(): Promise<ToolRunRow[]> {
    return this.sql<ToolRunRow>`
      SELECT run_id, parent_tool_call_id, agent_type, status, summary,
             error_message, display_order
      FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;
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
