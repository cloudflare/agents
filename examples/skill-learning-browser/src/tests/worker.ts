import { routeAgentRequest } from "agents";
import {
  TaskAgent as ProductionTaskAgent,
  SkillLearnerAgent,
  type BrowserSkill
} from "../server";

/**
 * Test-only extension of TaskAgent.
 *
 * Adds helper methods that let tests directly manipulate the skill registry
 * and inspect internal state without going through the LLM path.
 *
 * All public methods on a Durable Object class are automatically callable
 * via Workers RPC. The test harness imports this class, so tests call these
 * helpers as async methods on the DO stub returned by getAgentByName().
 */
export class TaskAgent extends ProductionTaskAgent {
  /** Directly insert a skill into the registry (bypasses LLM). */
  testSeedSkill(skill: BrowserSkill): void {
    this.saveSkill(skill);
  }

  /** Seed an agent-tool run row so sub-agent drill-in access control can be tested. */
  testSeedAgentToolRun(args: {
    runId: string;
    agentType?: string;
    inputPreview?: unknown;
  }): void {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type,
        input_preview, display_metadata, display_order,
        status, summary, error_message, started_at, completed_at
      )
      VALUES (
        ${args.runId}, ${null},
        ${args.agentType ?? "SkillLearnerAgent"},
        ${JSON.stringify(args.inputPreview ?? "learn skill")},
        ${JSON.stringify({ name: "Skill Learner" })},
        ${0}, ${"completed"}, ${null}, ${null},
        ${now}, ${now}
      )
    `;
  }

  /** Expose hasAgentToolRun for test assertions. */
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

export { SkillLearnerAgent };
