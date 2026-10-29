import { Think, skills } from "@cloudflare/think";
import { callable, routeAgentRequest } from "agents";
import type { ContextConfig } from "agents/context";
import { STARTER_SKILLS } from "./skill-files";

/** Key prefix that holds the skill directories in the bucket. */
const PREFIX = "skills/";

export type SkillSummary = {
  name: string;
  description: string;
  files: string[];
};

export type AddSkillResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * A Think agent that loads Agent Skills from an R2 bucket.
 *
 * Every `skills/<name>/SKILL.md` object is a skill and the objects beside it
 * are its files. Think lists the bucket before each turn, so a skill uploaded
 * to the bucket is available on the next message. With no Workspace to run
 * scripts in, the experimental skill script runner runs them in a Dynamic
 * Worker through `run_skill_script`.
 */
export class SkillsAgent extends Think<Env> {
  // `refreshIntervalMs: 0` re-lists the bucket on every turn so uploads show
  // up immediately. The default caches the listing for 60 seconds.
  private readonly skillSource = skills.r2(this.env.SKILLS_BUCKET, {
    prefix: PREFIX,
    refreshIntervalMs: 0
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
              "You are a helpful assistant demonstrating Agent Skills stored in R2.",
              "When a request matches an available skill, call activate_skill before answering.",
              "Mention which skill you used."
            ].join("\n")
        }
      }
    ];
  }

  override getSkills() {
    return [this.skillSource];
  }

  // TODO: Prefer storing skills in a Computer Workspace and running their
  // scripts with the Workspace runtime (see examples/computer-skills).
  override getSkillScriptRunner() {
    return skills.runner({ loader: this.env.LOADER });
  }

  override async onStart() {
    await this.seedStarterSkills();
  }

  /**
   * Upload the starter skills when the bucket has none, so the demo runs
   * without setup.
   *
   * TODO: Replace with Computer's loader for seeding skills.
   */
  private async seedStarterSkills() {
    const existing = await this.env.SKILLS_BUCKET.list({
      prefix: PREFIX,
      limit: 1
    });
    if (existing.objects.length > 0) return;
    for (const [key, content] of Object.entries(STARTER_SKILLS)) {
      await this.env.SKILLS_BUCKET.put(`${PREFIX}${key}`, content);
    }
  }

  /** The skills in the bucket right now, for the sidebar. */
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
   * Upload a new skill to the bucket. The model sees it on the next message.
   * The skill must follow the Agent Skills spec.
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
    // Sources load skills that break the spec with warnings; reject them
    // here, when the skill is written.
    const [warning] = parsed.warnings;
    if (warning) return { ok: false, error: warning.message };

    await this.env.SKILLS_BUCKET.put(
      `${PREFIX}${parsed.value.name}/SKILL.md`,
      markdown
    );
    return { ok: true, name: parsed.value.name };
  }

  /** Delete every object for a skill from the bucket. */
  @callable()
  async removeSkill(name: string): Promise<void> {
    const parsed = skills.parseSkillName(name);
    if (!parsed.ok) return;
    const objects = await this.env.SKILLS_BUCKET.list({
      prefix: `${PREFIX}${parsed.value}/`
    });
    await this.env.SKILLS_BUCKET.delete(objects.objects.map(({ key }) => key));
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
