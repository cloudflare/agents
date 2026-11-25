import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { renderSkillResource, type SkillCatalog } from "../catalog";
import type { SkillScriptFile, SkillScriptRunner } from "../script";

/**
 * AI SDK tools for Agent Skills, exported as `agents/skills/tools/ai-sdk`.
 *
 * Kept out of the `agents/skills` entry so the parser and sources do not
 * pull in `ai` or `zod`.
 *
 * @module
 */

/** Options for {@link createSkillTools}. */
export interface SkillToolsOptions {
  /** Enables `run_skill_script`. Experimental. */
  readonly scriptRunner?: SkillScriptRunner | null;
}

/**
 * Build AI SDK tools for a catalog: `activate_skill`, `read_skill_resource`,
 * and, with a script runner, `run_skill_script`.
 *
 * Failures (an unknown skill, a missing file) are thrown, so the AI SDK
 * returns them to the model as tool errors.
 *
 * @param catalog - The catalog to expose. Build tools again after reloading it.
 * @param options - Optional script runner.
 * @returns The tools, or an empty set when the catalog has no skills.
 */
export function createSkillTools(
  catalog: SkillCatalog,
  options: SkillToolsOptions = {}
): ToolSet {
  const names = catalog.skills.map((entry) => entry.skill.name);
  const [first, ...rest] = names;
  if (first === undefined) return {};
  const nameSchema = z.enum([first, ...rest]);

  const tools: ToolSet = {
    activate_skill: tool({
      description:
        "Activate a skill by name. Use this when the user's task matches one of the available skills.",
      inputSchema: z.object({ name: nameSchema }),
      execute: async ({ name }) => {
        const activated = catalog.activate(name);
        // Thrown errors reach the model as a tool error, with this message.
        if (!activated.ok) throw activated.error;
        return activated.value;
      }
    }),
    read_skill_resource: tool({
      description:
        "Read a bundled resource from an available skill by relative path. Pass name and path, or use a qualified path like skill-name/references/file.md.",
      inputSchema: z.object({
        name: nameSchema.optional(),
        path: z.string().min(1)
      }),
      execute: async ({ name, path }) => {
        const read = await catalog.readResource(
          name === undefined ? { path } : { name, path }
        );
        if (!read.ok) throw read.error;
        return renderSkillResource(read.value);
      }
    })
  };

  const runner = options.scriptRunner;
  if (runner) {
    tools.run_skill_script = tool({
      description:
        "Run a bundled script resource from an available skill. Use only when a skill instructs you to run a script.",
      inputSchema: z.object({
        name: nameSchema,
        path: z.string().min(1),
        input: z.unknown().default({})
      }),
      execute: async ({ name, path, input }) => {
        const script = await catalog.readResource({ name, path });
        if (!script.ok) throw script.error;
        const { entry, resource } = script.value;
        if (resource.kind !== "script") {
          throw new Error(`Resource is not a script: ${name}/${path}`);
        }
        if (resource.encoding !== "text") {
          throw new Error(`Script resource must be text: ${name}/${path}`);
        }

        const files: SkillScriptFile[] = [];
        for (const info of entry.resources) {
          const read = await catalog.readResource({ name, path: info.path });
          if (read.ok) {
            files.push({
              path: read.value.resource.path,
              content: read.value.resource.content,
              encoding: read.value.resource.encoding,
              kind: read.value.resource.kind
            });
          }
        }

        try {
          return await runner.run({
            skill: entry.skill,
            path: resource.path,
            source: resource.content,
            input,
            resources: files
          });
        } catch (error) {
          throw new Error(
            `Skill script failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
    });
  }

  return tools;
}
