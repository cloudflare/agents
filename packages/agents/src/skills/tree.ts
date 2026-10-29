import { parseSkill } from "./markdown";
import {
  describeSkillResource,
  isIgnoredSkillPath,
  parseSkillResourcePath,
  type SkillResourceInfo
} from "./resource";
import type { InvalidSkill, ListedSkill, SkillListing } from "./source";

/** @internal One file in a tree of skill directories. */
export interface SkillTreeFile {
  /** Path relative to the tree root, such as `my-skill/references/a.md`. */
  readonly path: string;
  /** Size in bytes, when known from the listing. */
  readonly size?: number;
}

/**
 * @internal Turn a flat list of files under a skills root into a listing.
 *
 * Each `<directory>/SKILL.md` one level below the root is a skill; every
 * other file in that directory is one of its resources. Workspace and R2
 * sources share this so both read the same layout the same way.
 *
 * @param files - Every file under the root.
 * @param readSkillFile - Read a root-relative `SKILL.md` as text.
 * @param location - Absolute directory for a skill, when the source has one.
 * @throws Whatever `readSkillFile` throws; callers wrap it as a source error.
 */
export async function indexSkillTree(
  files: readonly SkillTreeFile[],
  readSkillFile: (path: string) => Promise<string | null>,
  location?: (directory: string) => string
): Promise<SkillListing> {
  const byDirectory = new Map<string, SkillTreeFile[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    if (slash <= 0) continue;
    const directory = file.path.slice(0, slash);
    const entries = byDirectory.get(directory) ?? [];
    entries.push(file);
    byDirectory.set(directory, entries);
  }

  const skills: ListedSkill[] = [];
  const invalid: InvalidSkill[] = [];
  for (const directory of [...byDirectory.keys()].sort()) {
    const entries = byDirectory.get(directory) ?? [];
    const skillPath = `${directory}/SKILL.md`;
    if (!entries.some((entry) => entry.path === skillPath)) continue;

    const markdown = await readSkillFile(skillPath);
    if (markdown === null) continue;
    const parsed = parseSkill(markdown, { directory });
    if (!parsed.ok) {
      invalid.push({
        name: directory,
        location: skillPath,
        error: parsed.error
      });
      continue;
    }

    const resources: SkillResourceInfo[] = [];
    for (const entry of entries) {
      if (entry.path === skillPath) continue;
      const relative = entry.path.slice(directory.length + 1);
      if (isIgnoredSkillPath(relative)) continue;
      const path = parseSkillResourcePath(relative);
      if (path.ok)
        resources.push(describeSkillResource(path.value, entry.size));
    }
    resources.sort((a, b) => a.path.localeCompare(b.path));

    skills.push({
      skill: parsed.value,
      resources,
      ...(location === undefined ? {} : { location: location(directory) })
    });
  }

  return { skills, invalid };
}
