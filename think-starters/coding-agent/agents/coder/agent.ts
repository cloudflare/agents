import { Think, skills } from "@cloudflare/think";
import bundledSkills from "agents:skills";

/**
 * A coding agent.
 *
 * Think exposes `read`, `write`, `edit`, and a durable Code Mode `bash` tool.
 * Inside `bash`, the model gets `workspace.*`, `skills.*`, and `codemode.*`
 * globals. The colocated `skills/` directory is bundled via `agents:skills`;
 * the skill runner executes bundled scripts in an isolate.
 */
export class Coder extends Think<Env> {
  override getModel() {
    // Resolved via the built-in workers-ai-provider off env.AI. Use a
    // "@cf/..." id for Workers AI, or a "provider/model" slug like
    // "openai/gpt-5.5" to route through AI Gateway.
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You are a coding agent.",
      "Use read, write, and edit for focused file changes.",
      "Use bash for multi-file work: it runs JavaScript in a durable Code Mode sandbox.",
      "Inside bash, discover capabilities with codemode.search() and codemode.describe(); use workspace.* for filesystem operations and skills.* for on-demand instructions.",
      "Briefly explain your plan, then make focused, correct changes."
    ].join(" ");
  }

  override getSkills() {
    return [bundledSkills];
  }

  override getSkillScriptRunner() {
    return skills.runner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }
}
