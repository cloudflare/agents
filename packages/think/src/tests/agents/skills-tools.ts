/**
 * Test agent for Think's skills: the skill tools and the catalog block as
 * the model receives them. Skills are files in the agent's Workspace, so a
 * test changes the catalog between turns by writing one.
 */
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import { streamText, type LanguageModel } from "ai";
import { loadSkillCatalog } from "agents/skills";
import { createSkillTools } from "agents/skills/tools/ai-sdk";
import { Think } from "../../think";
import * as skills from "../../skills";
import type { StreamCallback } from "../../think";

type RequestTools = { name?: string }[] | undefined;
type PromptMessage = { role: string; content?: unknown };

const finishReason = { unified: "stop" as const, raw: undefined };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function createTextModel(
  requests: RequestTools[],
  prompts: PromptMessage[][] = []
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-skills-tools",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: {
      tools?: { name?: string }[];
      prompt?: PromptMessage[];
    }) {
      requests.push(options.tools);
      prompts.push(options.prompt ?? []);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

class CollectingCallback implements StreamCallback {
  onStart(): void {}
  onEvent(): void {}
  onDone(): void {}
  onError(): void {}
}

export class ThinkSkillsToolsTestAgent extends Think {
  override maxSteps = 1;
  readonly #requests: RequestTools[] = [];
  readonly #prompts: PromptMessage[][] = [];

  override getModel(): LanguageModel {
    return createTextModel(this.#requests, this.#prompts);
  }

  override getSkills() {
    return [skills.workspace(this.workspace)];
  }

  async writeSkill(name: string, description: string): Promise<void> {
    await this.workspace.fs.mkdir(`/workspace/.agents/skills/${name}`, {
      recursive: true
    });
    await this.workspace.fs.writeFile(
      `/workspace/.agents/skills/${name}/SKILL.md`,
      new TextEncoder().encode(
        `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`
      )
    );
  }

  /** One turn: the system text and last message the model received. */
  async turn(input: string): Promise<{ system: string; last: string }> {
    await this.chat(input, new CollectingCallback());
    const prompt = this.#prompts.at(-1) ?? [];
    return {
      system: JSON.stringify(prompt.filter((m) => m.role === "system")),
      last: JSON.stringify(prompt.at(-1) ?? null)
    };
  }

  /**
   * The last turn's tool definitions, and the workspace and skill tools as
   * `streamText` sends them given directly, in that order: all as JSON.
   */
  async toolRequests(): Promise<{ turn: string; direct: string }> {
    const catalog = await loadSkillCatalog(this.getSkills());
    const direct: RequestTools[] = [];
    await streamText({
      model: createTextModel(direct),
      tools: {
        ...createAITools({ workspace: this.workspace }),
        ...createSkillTools(catalog, { scriptRunner: null })
      },
      prompt: "hello"
    }).consumeStream();
    return {
      turn: JSON.stringify(this.#requests.at(-1) ?? []),
      direct: JSON.stringify(direct[0] ?? [])
    };
  }
}
