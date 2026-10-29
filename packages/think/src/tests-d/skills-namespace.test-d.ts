import type * as agentSkills from "agents/skills";
import type * as agentSkillsRunner from "agents/skills/runner";
import type { skills } from "../think";

// Think's `skills` namespace lists `agents/skills` exports by name. This
// fails to compile when `agents/skills` gains a value export Think misses.
type MissingValues = Exclude<
  keyof typeof agentSkills | keyof typeof agentSkillsRunner,
  keyof typeof skills
>;
const noMissingValues: [MissingValues] extends [never] ? true : MissingValues =
  true;
void noMissingValues;

// Types are reachable through the namespace too.
type SourceFromThink = skills.SkillSource;
type SourceFromAgents = agentSkills.SkillSource;
const sameSource: SourceFromThink extends SourceFromAgents ? true : false =
  true;
void sameSource;
