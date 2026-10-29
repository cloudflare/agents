import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { Think, skills } from "@cloudflare/think";
import { callable, routeAgentRequest } from "agents";
import type { ContextConfig } from "agents/context";
import { STARTER_SKILLS } from "./skill-files";

/** Where skills live in the Workspace: the cross-client Agent Skills folder. */
const SKILLS_ROOT = skills.DEFAULT_WORKSPACE_SKILLS_ROOT;

export type SkillSummary = {
  name: string;
  description: string;
  files: string[];
};

export type AddSkillResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * A Think agent whose skills are files in its Computer Workspace.
 *
 * Every `/workspace/.agents/skills/<name>/SKILL.md` is a skill. Think lists
 * the folder before each turn, so a skill the user (or the agent itself)
 * writes there is available on the next message. Scripts are files too: the
 * model runs them with the Workspace's `exec` tool.
 */
export class SkillsAgent extends Think<Env> {
  override workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerJavaScriptBackend({
        id: "js",
        loader: this.env.LOADER,
        access: "read-write"
      })
    ]
  });

  private readonly skillSource = skills.workspace(this.workspace, {
    root: SKILLS_ROOT
  });

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override configureContext(): ContextConfig[] {
    return [
      {
        label: "instructions",
        description: "How to use skills in this demo.",
        provider: {
          get: async () =>
            [
              "You are a helpful assistant demonstrating Agent Skills stored in a Workspace.",
              "When a request matches an available skill, call activate_skill before answering.",
              "Skill scripts are files in the Workspace. Run them with the exec tool as the skill describes.",
              "Mention which skill you used."
            ].join("\n")
        }
      }
    ];
  }

  override getSkills() {
    return [this.skillSource];
  }

  override async onStart() {
    await this.seedStarterSkills();
  }

  /**
   * Write the starter skills the first time the agent runs. Existing files
   * are left alone, so edits and deletions made later stick.
   *
   * TODO: Replace with Computer's loader for seeding a Workspace from files.
   */
  private async seedStarterSkills() {
    const marker = `${SKILLS_ROOT}/.seeded`;
    const seeded = await this.workspace.fs.stat(marker).then(
      () => true,
      () => false
    );
    if (seeded) return;
    for (const [path, content] of Object.entries(STARTER_SKILLS)) {
      const absolute = `${SKILLS_ROOT}/${path}`;
      await this.workspace.fs.mkdir(
        absolute.slice(0, absolute.lastIndexOf("/")),
        { recursive: true }
      );
      await this.workspace.fs.writeFile(absolute, content);
    }
    await this.workspace.fs.writeFile(marker, "");
  }

  /** The skills in the Workspace right now, for the sidebar. */
  @callable()
  async listSkills(): Promise<SkillSummary[]> {
    const listed = await this.skillSource.list();
    if (!listed.ok) return [];
    return listed.value.skills.map(({ skill, resources }) => ({
      name: skill.name,
      description: skill.description,
      files: resources.map((resource) => resource.path)
    }));
  }

  /**
   * Write a new skill into the Workspace. The model sees it on the next
   * message. The skill must follow the Agent Skills spec.
   */
  @callable()
  async addSkill(input: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<AddSkillResult> {
    const markdown = `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.instructions}\n`;
    const parsed = skills.parseSkill(markdown, { directory: input.name });
    if (!parsed.ok) return { ok: false, error: parsed.error.message };

    const directory = `${SKILLS_ROOT}/${parsed.value.name}`;
    await this.workspace.fs.mkdir(directory, { recursive: true });
    await this.workspace.fs.writeFile(`${directory}/SKILL.md`, markdown);
    return { ok: true, name: parsed.value.name };
  }

  /** Delete a skill folder from the Workspace. */
  @callable()
  async removeSkill(name: string): Promise<void> {
    const parsed = skills.parseSkillName(name);
    if (!parsed.ok) return;
    await this.workspace.fs.rm(`${SKILLS_ROOT}/${parsed.value}`, {
      recursive: true,
      force: true
    });
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
