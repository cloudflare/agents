import { Type } from "@earendil-works/pi-ai";
import type {
  Extension,
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";
import {
  formatSkillDiagnostic,
  loadSkillCatalog,
  renderSkillResource,
  type SkillCatalog
} from "../../skills/catalog";
import type { SkillSource } from "../../skills/source";

function textResult(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

/**
 * Model-facing tools for a catalog: `activate_skill` and
 * `read_skill_resource`. These match the tools `@cloudflare/think` offers, so
 * a skill behaves the same in both frameworks.
 */
function skillTools(catalog: SkillCatalog): ToolRegistration[] {
  const names = catalog.skills.map((entry) => entry.skill.name);
  if (names.length === 0) return [];
  const nameSchema = Type.Union(names.map((name) => Type.Literal(name)));

  const activateParameters = Type.Object({ name: nameSchema });
  const activateSkill: ToolRegistration<typeof activateParameters> = {
    name: "activate_skill",
    description:
      "Activate a skill by name. Use this when the user's task matches one of the available skills; the response contains the skill's full instructions.",
    parameters: activateParameters,
    replay: "safe",
    async execute(input) {
      const activated = catalog.activate(input.name);
      return textResult(
        activated.ok ? activated.value : activated.error.message
      );
    }
  };

  const resourceParameters = Type.Object({
    name: Type.Optional(nameSchema),
    path: Type.String({ minLength: 1 })
  });
  const readResource: ToolRegistration<typeof resourceParameters> = {
    name: "read_skill_resource",
    description:
      "Read a file bundled with a skill, such as a reference document or template. Provide the skill name and the file's path from the skill's resource list, or a qualified path like skill-name/references/file.md.",
    parameters: resourceParameters,
    replay: "safe",
    async execute(input) {
      const read = await catalog.readResource(
        input.name === undefined
          ? { path: input.path }
          : { name: input.name, path: input.path }
      );
      return textResult(
        read.ok ? renderSkillResource(read.value) : read.error.message
      );
    }
  };

  return [activateSkill, readResource];
}

/**
 * `agents/skills` sources as a pi extension, named `agents.skills`: the
 * activation tools and a `skills` system prompt section. Install it on
 * pi's registry in the harness factory. Sources are read once, when the
 * extension is built.
 *
 * ```ts
 * import * as agentSkills from "agents/skills";
 *
 * registry.install(
 *   await skills([agentSkills.workspace(workspace), agentSkills.r2(env.SKILLS)])
 * );
 * ```
 *
 * @param sources - Skill sources in priority order.
 * @returns The pi extension.
 */
export async function skills(
  sources: readonly SkillSource[]
): Promise<Extension> {
  const catalog = await loadSkillCatalog(sources);
  for (const diagnostic of catalog.diagnostics) {
    console.warn(`pi skills: ${formatSkillDiagnostic(diagnostic)}`);
  }
  const prompt = catalog.prompt();
  return {
    name: "agents.skills",
    tools: skillTools(catalog),
    sections: prompt === null ? [] : [{ key: "skills", render: () => prompt }]
  };
}
