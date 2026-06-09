import { Think, skills } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import bundledSkills from "agents:skills";

type Env = Cloudflare.Env & {
  AI: Ai;
  LOADER: WorkerLoader;
};

/**
 * A coding agent.
 *
 * Think's built-in workspace tools (read, write, edit, list, find, grep,
 * delete) give the model a persistent virtual filesystem to work in. The
 * colocated `skills/` directory is bundled via `agents:skills` and surfaced to
 * the model on demand; the skill runner executes skill scripts in an isolate
 * using the Worker Loader binding.
 */
export class Coder extends Think<Env> {
  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6",
      {
        sessionAffinity: this.sessionAffinity
      }
    );
  }

  override getSystemPrompt() {
    return "You are a coding agent. Use the workspace file tools to read, write, and edit code. Briefly explain your plan, then make focused, correct changes.";
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
