import { Think, type Session, type SkillSource } from "@cloudflare/think";
import { configureAgentThinkSession, type RunContext } from "../src/agent";

const promptTestSkillSource: SkillSource = {
  id: "agent-think-prompt-test",
  fingerprint: "agent-think-prompt-test-v1",
  async list() {
    return [
      {
        name: "prompt-test",
        description: "Verify agent-think prompt composition."
      }
    ];
  },
  async load(name) {
    return name === "prompt-test"
      ? {
          name,
          description: "Verify agent-think prompt composition.",
          body: "Follow the prompt composition test procedure."
        }
      : null;
  }
};

export class AgentThinkPromptTestAgent extends Think<Env> {
  #runContext: RunContext = {
    repo: "cloudflare/agents",
    issueNumber: 1871,
    instruction: "Open a focused fix PR.",
    installationToken: "",
    commentId: 123
  };

  override configureSession(session: Session): Session {
    return configureAgentThinkSession(session, () => this.#runContext);
  }

  override getSkills(): SkillSource[] {
    return [promptTestSkillSource];
  }

  async getFrozenPrompt(): Promise<string> {
    return this.session.freezeSystemPrompt();
  }

  async setInstruction(instruction: string): Promise<void> {
    this.#runContext = { ...this.#runContext, instruction };
    await this.session.refreshSystemPrompt();
  }
}

export * from "../src/index";
export { default } from "../src/index";
