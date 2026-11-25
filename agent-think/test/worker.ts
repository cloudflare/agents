import { skills, Think, type SkillSource } from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import { agentThinkContext, type RunContext } from "../src/agent";

const promptTestSkillSource: SkillSource = skills.manifest({
  id: "agent-think-prompt-test",
  skills: [
    {
      name: "prompt-test",
      description: "Verify agent-think prompt composition.",
      body: "Follow the prompt composition test procedure."
    }
  ]
});

export class AgentThinkPromptTestAgent extends Think<Env> {
  #runContext: RunContext = {
    repo: "cloudflare/agents",
    issueNumber: 1871,
    instruction: "Open a focused fix PR.",
    installationToken: "",
    commentId: 123
  };

  override configureContext(): ContextConfig[] {
    return agentThinkContext(() => this.#runContext);
  }

  override getSkills(): SkillSource[] {
    return [promptTestSkillSource];
  }

  async getFrozenPrompt(): Promise<string> {
    return this.context.freezeSystemPrompt();
  }

  async setInstruction(instruction: string): Promise<void> {
    this.#runContext = { ...this.#runContext, instruction };
    await this.context.refreshSystemPrompt();
  }
}

export * from "../src/index";
export { default } from "../src/index";
