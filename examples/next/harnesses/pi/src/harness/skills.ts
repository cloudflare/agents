import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";
import type {
  SkillContent,
  SkillDescriptor,
  SkillResourceDescriptor,
  SkillSource
} from "agents/skills";

/** Skills resolved from `agents/skills` sources for one process lifetime. */
export type ResolvedSkills = {
  /** Changes when any source's fingerprint changes. */
  readonly fingerprint: string;
  /** Model-facing activation tools; empty when there are no skills. */
  readonly tools: readonly ToolRegistration[];
  /** System-prompt catalog, or null when there are no skills. */
  readonly catalog: string | null;
  readonly warnings: readonly string[];
};

type ResolvedSkill = {
  readonly descriptor: SkillDescriptor;
  readonly content: SkillContent;
  readonly source: SkillSource;
};

export function skillsFingerprint(sources: readonly SkillSource[]): string {
  return sources
    .map((source) => `${source.id}:${source.fingerprint}`)
    .join("|");
}

function textResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }] };
}

/** pi validates arguments against the schema before `execute` runs. */
function argsOf<T>(args: JsonValue): T {
  return args as T;
}

function attributes(
  pairs: ReadonlyArray<readonly [string, string | undefined]>
) {
  return pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
    .map(([key, value]) => ` ${key}="${value.replace(/"/g, "&quot;")}"`)
    .join("");
}

function describeResource(resource: SkillResourceDescriptor): string {
  const details = [
    resource.kind,
    resource.encoding ?? "text",
    resource.mimeType,
    resource.size === undefined ? undefined : `${resource.size} bytes`
  ].filter((value): value is string => value !== undefined);
  return `- ${resource.path} (${details.join(", ")})`;
}

function renderSkillContent(skill: ResolvedSkill): string {
  const resources = skill.content.resources ?? [];
  const lines = [
    `<skill_content${attributes([
      ["name", skill.descriptor.name],
      ["version", skill.descriptor.version]
    ])}>`,
    skill.content.body.trim()
  ];
  if (resources.length > 0) {
    lines.push("<skill_resources>");
    for (const resource of resources) {
      lines.push(
        `  <file${attributes([
          ["kind", resource.kind],
          ["encoding", resource.encoding ?? "text"],
          [
            "size",
            resource.size === undefined ? undefined : String(resource.size)
          ]
        ])}>${resource.path}</file>`
      );
    }
    lines.push("</skill_resources>");
  }
  lines.push("</skill_content>", "");
  lines.push(
    resources.length === 0
      ? "No bundled resources."
      : ["Bundled resources:", ...resources.map(describeResource)].join("\n")
  );
  return lines.join("\n");
}

/**
 * Resolve `agents/skills` sources into a system-prompt catalog and two
 * tools.
 *
 * The first source to list a name wins, as in `SkillRegistry`. pi-durable
 * has no skill concept of its own, so the model activates skills through
 * `activate_skill` and reads bundled files through `read_skill_resource` —
 * the same tools `@cloudflare/think` offers, so skills authored for one
 * framework work in the other.
 */
export async function resolveSkillSources(
  sources: readonly SkillSource[]
): Promise<ResolvedSkills> {
  const fingerprint = skillsFingerprint(sources);
  const warnings: string[] = [];
  const resolved = new Map<string, ResolvedSkill>();
  for (const source of sources) {
    let descriptors: SkillDescriptor[];
    try {
      descriptors = await source.list();
    } catch (error) {
      warnings.push(
        `Skill source "${source.id}" failed to list skills: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }
    for (const descriptor of descriptors) {
      if (resolved.has(descriptor.name)) {
        warnings.push(
          `Skill "${descriptor.name}" from source "${source.id}" is shadowed by an earlier source`
        );
        continue;
      }
      let content: SkillContent | null;
      try {
        content = await source.load(descriptor.name);
      } catch (error) {
        warnings.push(
          `Skill "${descriptor.name}" from source "${source.id}" failed to load: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
      if (!content) continue;
      resolved.set(descriptor.name, { descriptor, content, source });
    }
  }

  const visible = [...resolved.values()].filter(
    (skill) => skill.descriptor.metadata?.["disable-model-invocation"] !== true
  );
  if (visible.length === 0) {
    return { fingerprint, tools: [], catalog: null, warnings };
  }

  const names = visible.map((skill) => skill.descriptor.name);
  const nameSchema = Type.Union(names.map((name) => Type.Literal(name)));
  const byName = new Map(
    visible.map((skill) => [skill.descriptor.name, skill])
  );

  const activateParameters = Type.Object({ name: nameSchema });
  const activateSkill: ToolRegistration = {
    name: "activate_skill",
    description:
      "Activate a skill by name. Use this when the user's task matches one of the available skills; the response contains the skill's full instructions.",
    parameters: activateParameters,
    replay: "safe",
    async execute(args) {
      const input = argsOf<{ name: string }>(args);
      const skill = byName.get(input.name);
      return textResult(
        skill ? renderSkillContent(skill) : `Skill not found: ${input.name}`
      );
    }
  };

  const resourceParameters = Type.Object({
    name: Type.Optional(nameSchema),
    path: Type.String({ minLength: 1 })
  });
  const readResource: ToolRegistration = {
    name: "read_skill_resource",
    description:
      "Read a file bundled with a skill, such as a reference document or template. Provide the skill name and the file's path from the skill's resource list.",
    parameters: resourceParameters,
    replay: "safe",
    async execute(args) {
      const input = argsOf<{ name?: string; path: string }>(args);
      const target = resolveResourceTarget(byName, input.name, input.path);
      if (!target) {
        return textResult(
          `Skill resource not found: ${input.name ? `${input.name}/` : ""}${input.path}`
        );
      }
      const resource = await target.skill.source
        .readResource?.(target.skill.descriptor.name, target.path)
        .catch(() => null);
      if (!resource) {
        return textResult(
          `Skill resource not found: ${target.skill.descriptor.name}/${target.path}`
        );
      }
      return textResult(
        [
          `<skill_resource${attributes([
            ["name", target.skill.descriptor.name],
            ["path", resource.path],
            ["kind", resource.kind],
            ["encoding", resource.encoding ?? "text"],
            ["mimeType", resource.mimeType]
          ])}>`,
          resource.content,
          "</skill_resource>"
        ].join("\n")
      );
    }
  };

  const catalog = [
    "Available skills. When a task matches a skill, use activate_skill with its name before proceeding.",
    "",
    ...visible.map(
      (skill) => `- ${skill.descriptor.name}: ${skill.descriptor.description}`
    )
  ].join("\n");

  return {
    fingerprint,
    tools: [activateSkill, readResource],
    catalog,
    warnings
  };
}

function resolveResourceTarget(
  byName: ReadonlyMap<string, ResolvedSkill>,
  name: string | undefined,
  path: string
): { readonly skill: ResolvedSkill; readonly path: string } | undefined {
  if (path.split("/").some((segment) => segment === "..")) return undefined;
  if (name !== undefined) {
    const skill = byName.get(name);
    return skill && hasResource(skill, path) ? { skill, path } : undefined;
  }
  // A qualified path names the skill in its first segment.
  const [head, ...rest] = path.split("/");
  const skill = head === undefined ? undefined : byName.get(head);
  const relative = rest.join("/");
  return skill && relative && hasResource(skill, relative)
    ? { skill, path: relative }
    : undefined;
}

function hasResource(skill: ResolvedSkill, path: string): boolean {
  return (skill.content.resources ?? []).some(
    (resource) => resource.path === path
  );
}
