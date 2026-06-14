import { callable, routeAgentRequest } from "agents";
import { Think, skills } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import bundledSkills from "agents:skills";

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  SkillsAgent: DurableObjectNamespace<SkillsAgent>;
};

export class SkillsAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  getSystemPrompt() {
    return [
      "You are a helpful assistant demonstrating Think Agent Skills.",
      "If a user request matches an available skill, call activate_skill before answering.",
      "Mention which skill you used when it is helpful for the demo."
    ].join("\n");
  }

  getSkills() {
    return [bundledSkills];
  }

  getSkillScriptRunner() {
    return skills.runner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }

  @callable()
  async listSkills() {
    return bundledSkills.list();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
