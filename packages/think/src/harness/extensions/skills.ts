/**
 * The skills from `getSkills()` as an extension on ThinkHarness's core: the
 * skill tools, and the catalog as a remind section, so a changed catalog
 * reaches the model as a reminder without rewriting the recorded prompt.
 * The same `ThinkSkills` Think uses.
 *
 * @internal Not exported from any entry point.
 */
import type { SkillScriptRunner, SkillSource } from "agents/skills";
import {
  SKILLS_CONTEXT_DESCRIPTION,
  SKILLS_CONTEXT_LABEL,
  ThinkSkills
} from "../../skills-runtime";
import type { ThinkExtension } from "./workspace";

/**
 * Load the catalog from `sources()` on the first build and list it again on
 * each later one; nothing while there are no sources.
 *
 * @internal
 */
export function skillsExtension(
  sources: () => SkillSource[] | Promise<SkillSource[]>,
  scriptRunner: () => SkillScriptRunner | null
): ThinkExtension {
  const skills = new ThinkSkills();
  let started: Promise<boolean> | undefined;
  return (ctx) => {
    // A build's tool transforms run before its prompt transforms, so the
    // section below reads the catalog this one listed.
    ctx.tools.transform(async (tools) => {
      if (started) await skills.refresh();
      else await (started = skills.start(sources));
      for (const [name, tool] of Object.entries(skills.tools(scriptRunner))) {
        tools.set(name, tool);
      }
    });
    ctx.prompt.transform(async (prompt) => {
      if (!(await started)) return;
      prompt.set(SKILLS_CONTEXT_LABEL, {
        text: skills.prompt(),
        description: SKILLS_CONTEXT_DESCRIPTION,
        whenChanged: "remind"
      });
    });
  };
}
