import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  SkillContent,
  SkillDescriptor,
  SkillRegistrySnapshot,
  SkillResourceDescriptor,
  SkillScriptRunner,
  SkillSource
} from "./types";
import { validateSkillScriptPath } from "./runner";

const SKILL_CONTEXT_LABEL = "think_skills";

function stableSourceFingerprint(sources: SkillSource[]): string {
  return sources
    .map((source) => `${source.id}:${source.fingerprint}`)
    .join("|");
}

function wrapSkillContent(skill: SkillContent): string {
  const version = skill.version ? ` version="${skill.version}"` : "";
  const resourceList = skill.resources?.length
    ? [
        "",
        "<skill_resources>",
        ...skill.resources.map((resource) => `  <file>${resource.path}</file>`),
        "</skill_resources>"
      ].join("\n")
    : "";

  return [
    `<skill_content name="${skill.name}"${version}>`,
    skill.body.trim(),
    resourceList,
    "</skill_content>"
  ].join("\n");
}

function renderResourceList(
  resources: SkillResourceDescriptor[] | undefined
): string {
  if (!resources?.length) return "No bundled resources.";
  return resources
    .map((resource) => `- ${resource.path} (${resource.kind})`)
    .join("\n");
}

export class SkillRegistry {
  readonly contextLabel = SKILL_CONTEXT_LABEL;

  private sources: SkillSource[];
  private scriptRunner: SkillScriptRunner | null;
  private descriptors = new Map<string, SkillDescriptor>();
  private sourceBySkill = new Map<string, SkillSource>();
  private loaded = false;

  constructor(
    sources: SkillSource[],
    scriptRunner: SkillScriptRunner | null = null
  ) {
    this.sources = sources;
    this.scriptRunner = scriptRunner;
  }

  get fingerprint(): string {
    return stableSourceFingerprint(this.sources);
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    this.descriptors.clear();
    this.sourceBySkill.clear();

    for (const source of this.sources) {
      for (const descriptor of await source.list()) {
        const existing = this.descriptors.get(descriptor.name);
        if (existing) {
          throw new Error(
            `Duplicate skill "${descriptor.name}" from ${source.id}; already registered from ${existing.sourceId}.`
          );
        }
        this.descriptors.set(descriptor.name, {
          ...descriptor,
          sourceId: descriptor.sourceId ?? source.id
        });
        this.sourceBySkill.set(descriptor.name, source);
      }
    }

    this.loaded = true;
  }

  async refresh(): Promise<void> {
    await Promise.all(this.sources.map((source) => source.refresh?.()));
    this.loaded = false;
    await this.load();
  }

  async snapshot(): Promise<SkillRegistrySnapshot> {
    await this.load();

    const catalog: string[] = [];

    for (const descriptor of this.descriptors.values()) {
      catalog.push(`- ${descriptor.name}: ${descriptor.description}`);
    }

    return {
      fingerprint: this.fingerprint,
      catalogPrompt: catalog.length
        ? [
            "Available skills. When a task matches a skill, use activate_skill with its name before proceeding.",
            "",
            ...catalog
          ].join("\n")
        : null
    };
  }

  async systemPrompt(): Promise<string | null> {
    const snapshot = await this.snapshot();
    return snapshot.catalogPrompt;
  }

  async loadSkill(name: string): Promise<SkillContent | null> {
    await this.load();
    const source = this.sourceBySkill.get(name);
    return source ? source.load(name) : null;
  }

  tools(): ToolSet {
    const modelSkillNames = [...this.descriptors.values()].map(
      (skill) => skill.name
    );

    const tools: ToolSet = {};

    if (modelSkillNames.length > 0) {
      tools.activate_skill = tool({
        description:
          "Activate a skill by name. Use this when the user's task matches one of the available skills.",
        inputSchema: z.object({
          name: z.enum(modelSkillNames as [string, ...string[]])
        }),
        execute: async ({ name }: { name: string }) => {
          const skill = await this.loadSkill(name);
          if (!skill) {
            return `Skill not found: ${name}`;
          }
          return [
            wrapSkillContent(skill),
            "",
            "Bundled resources:",
            renderResourceList(skill.resources)
          ].join("\n");
        }
      });
    }

    if (modelSkillNames.length > 0) {
      tools.read_skill_resource = tool({
        description:
          "Read a bundled resource from an available skill by relative path.",
        inputSchema: z.object({
          name: z.enum(modelSkillNames as [string, ...string[]]),
          path: z.string().min(1)
        }),
        execute: async ({ name, path }: { name: string; path: string }) => {
          const source = this.sourceBySkill.get(name);
          if (!source?.readResource)
            return `Skill "${name}" has no readable resources.`;
          const resource = await source.readResource(name, path);
          if (!resource) return `Resource not found: ${name}/${path}`;
          return [
            `<skill_resource name="${name}" path="${resource.path}" kind="${resource.kind}">`,
            resource.content,
            "</skill_resource>"
          ].join("\n");
        }
      });
    }

    if (modelSkillNames.length > 0 && this.scriptRunner) {
      tools.run_skill_script = tool({
        description:
          "Run a bundled script resource from an available skill. Use only when a skill instructs you to run a script.",
        inputSchema: z.object({
          name: z.enum(modelSkillNames as [string, ...string[]]),
          path: z.string().min(1),
          input: z.unknown().default({})
        }),
        execute: async ({
          name,
          path,
          input = {}
        }: {
          name: string;
          path: string;
          input: unknown;
        }) => {
          const validation = validateSkillScriptPath(path);
          if (!validation.ok) return validation.error;

          const skill = await this.loadSkill(name);
          if (!skill) return `Skill not found: ${name}`;

          const script = skill.resources?.find(
            (resource) => resource.path === path
          );
          if (!script) return `Script not found: ${name}/${path}`;
          if (script.kind !== "script") {
            return `Resource is not a script: ${name}/${path}`;
          }

          const source = this.sourceBySkill.get(name);
          if (!source?.readResource) {
            return `Skill "${name}" has no readable resources.`;
          }

          const resource = await source.readResource(name, path);
          if (!resource) return `Script not found: ${name}/${path}`;

          try {
            return await this.scriptRunner!.run({
              skill,
              path,
              source: resource.content,
              input
            });
          } catch (error) {
            return `Skill script failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      });
    }

    return tools;
  }
}
