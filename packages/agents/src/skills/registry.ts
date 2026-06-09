import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  SkillContent,
  SkillDescriptor,
  SkillRegistrySnapshot,
  SkillResource,
  SkillResourceDescriptor,
  SkillScriptRunner,
  SkillSource
} from "./types";
import { validateSkillResourcePath } from "./types";
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
        ...skill.resources.map(
          (resource) =>
            `  <file kind="${resource.kind}" encoding="${resource.encoding ?? "text"}"${resource.size === undefined ? "" : ` size="${resource.size}"`}>${resource.path}</file>`
        ),
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
    .map((resource) => {
      const encoding = resource.encoding ?? "text";
      const size =
        resource.size === undefined ? "" : `, ${resource.size} bytes`;
      const mimeType = resource.mimeType ? `, ${resource.mimeType}` : "";
      return `- ${resource.path} (${resource.kind}, ${encoding}${mimeType}${size})`;
    })
    .join("\n");
}

function validateResourcePath(path: string): string | null {
  if (path.startsWith("../")) {
    return `Resource paths cannot use "../". To read from another skill, use a qualified path like "other-skill/references/file.md".`;
  }
  return validateSkillResourcePath(path);
}

export class SkillRegistry {
  readonly contextLabel = SKILL_CONTEXT_LABEL;

  /**
   * Non-fatal diagnostics collected during the most recent {@link load} or
   * {@link refresh} (duplicate skill names, sources that failed to list).
   * Reset on every load so it never grows unbounded across refreshes.
   */
  readonly warnings: string[] = [];

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
    this.warnings.length = 0;

    // Skills are applied in `getSkills()` order: the first source to register
    // a name wins, and later collisions are skipped with a diagnostic. A bad
    // source must not take down the whole registry, so listing failures are
    // also recorded rather than thrown.
    for (const source of this.sources) {
      let descriptors: SkillDescriptor[];
      try {
        descriptors = await source.list();
      } catch (error) {
        this.warnings.push(
          `Skill source "${source.id}" failed to list skills and was skipped: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      for (const descriptor of descriptors) {
        const existing = this.descriptors.get(descriptor.name);
        if (existing) {
          this.warnings.push(
            `Duplicate skill "${descriptor.name}" from ${source.id} ignored; already registered from ${existing.sourceId}.`
          );
          continue;
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
    const refreshErrors: string[] = [];
    await Promise.all(
      this.sources.map(async (source) => {
        try {
          await source.refresh?.();
        } catch (error) {
          refreshErrors.push(
            `Skill source "${source.id}" failed to refresh: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
    );
    this.loaded = false;
    await this.load();
    // `load()` reset warnings; re-append any refresh failures so they surface.
    this.warnings.push(...refreshErrors);
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

  private resolveResourceTarget(
    name: string | undefined,
    path: string
  ):
    | {
        ok: true;
        name: string;
        path: string;
      }
    | {
        ok: false;
        error: string;
      } {
    const pathError = validateResourcePath(path);
    if (pathError) return { ok: false, error: pathError };

    if (name) return { ok: true, name, path };

    const [candidateName, ...rest] = path.split("/");
    if (!candidateName || rest.length === 0) {
      return {
        ok: false,
        error:
          "Resource path must include a skill name when name is omitted, for example: cloudflare-brand/references/tokens.md"
      };
    }
    if (!this.descriptors.has(candidateName)) {
      return {
        ok: false,
        error: `Unknown skill in qualified resource path: ${candidateName}`
      };
    }
    return { ok: true, name: candidateName, path: rest.join("/") };
  }

  private async readResource(
    name: string,
    path: string
  ): Promise<SkillResource | string> {
    const source = this.sourceBySkill.get(name);
    if (!source?.readResource) {
      return `Skill "${name}" has no readable resources.`;
    }
    const resource = await source.readResource(name, path);
    return resource ?? `Resource not found: ${name}/${path}`;
  }

  private async readSkillResources(
    skill: SkillContent
  ): Promise<SkillResource[]> {
    const resources: SkillResource[] = [];
    for (const descriptor of skill.resources ?? []) {
      const resource = await this.readResource(skill.name, descriptor.path);
      if (typeof resource !== "string") resources.push(resource);
    }
    return resources;
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
          "Read a bundled resource from an available skill by relative path. Pass name and path, or use a qualified path like skill-name/references/file.md.",
        inputSchema: z.object({
          name: z.enum(modelSkillNames as [string, ...string[]]).optional(),
          path: z.string().min(1)
        }),
        execute: async ({ name, path }: { name?: string; path: string }) => {
          const target = this.resolveResourceTarget(name, path);
          if (!target.ok) return target.error;

          const resource = await this.readResource(target.name, target.path);
          if (typeof resource === "string") return resource;

          const encoding = resource.encoding ?? "text";
          const mimeType = resource.mimeType
            ? ` mimeType="${resource.mimeType}"`
            : "";
          return [
            `<skill_resource name="${target.name}" path="${resource.path}" kind="${resource.kind}" encoding="${encoding}"${mimeType}>`,
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
          if ((resource.encoding ?? "text") !== "text") {
            return `Script resource must be text, got ${resource.encoding}: ${name}/${path}`;
          }

          try {
            return await this.scriptRunner!.run({
              skill,
              path,
              source: resource.content,
              input,
              resources: await this.readSkillResources(skill)
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
