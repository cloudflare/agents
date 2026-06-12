import { Think, skills } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
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
    return "You are a coding agent. Use the workspace file tools to read, write, and edit code. For multi-file operations or anything that would take many sequential tool calls, write code with the execute tool instead. Briefly explain your plan, then make focused, correct changes.";
  }

  override getTools() {
    return {
      // Durable sandboxed code execution: the model writes TypeScript
      // against `state.*` (this agent's workspace filesystem) and
      // `codemode.*` (discovery + saved snippets), recorded on a durable
      // runtime with abort-and-replay and human approvals.
      //
      // Setup checklist (already wired in this starter):
      //   - wrangler.jsonc: "worker_loaders": [{ "binding": "LOADER" }]
      //   - optional:       "browser": { "binding": "BROWSER" } for cdp.*
      //   - the Think framework's generated worker entry exports the
      //     CodemodeRuntime facet class automatically
      execute: createExecuteTool(this)
    };
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
