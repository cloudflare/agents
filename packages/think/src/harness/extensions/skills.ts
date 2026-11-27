/**
 * The skills from `getSkills()` as an extension on ThinkHarness's core: the
 * skill tools, and the catalog as a remind section, so a changed catalog
 * reaches the model as a reminder without rewriting the recorded prompt.
 * The same `ThinkSkills` Think uses, started by the host in onStart.
 *
 * @internal Not exported from any entry point.
 */
import type { SkillScriptRunner } from "agents/skills";
import {
  SKILLS_CONTEXT_DESCRIPTION,
  SKILLS_CONTEXT_LABEL,
  type ThinkSkills
} from "../../skills-runtime";
import { setTool, type ThinkExtension } from "./workspace";

/** The skills tools that only read. */
const SKILL_READS = new Set(["activate_skill", "read_skill_resource"]);

/**
 * List the catalog again on each build and offer its tools and section;
 * nothing while no catalog loaded.
 *
 * @internal
 */
export function skillsExtension(
  skills: ThinkSkills,
  scriptRunner: () => SkillScriptRunner | null
): ThinkExtension {
  return (ctx) => {
    // A build's tool transforms run before its prompt transforms, so the
    // section below reads the catalog this one listed.
    ctx.tools.transform(async (tools) => {
      await skills.refresh();
      for (const [name, tool] of Object.entries(skills.tools(scriptRunner))) {
        setTool(tools, name, tool, SKILL_READS);
      }
    });
    ctx.prompt.transform((prompt) => {
      if (!skills.loaded) return;
      prompt.set(SKILLS_CONTEXT_LABEL, {
        text: skills.prompt(),
        description: SKILLS_CONTEXT_DESCRIPTION,
        whenChanged: "remind"
      });
    });
  };
}
