import type { SkillResult } from "./result";
import {
  describeSkillResource,
  isIgnoredSkillPath,
  parseSkillResourcePath,
  type SkillResource,
  type SkillResourceInfo,
  type SkillResourcePath
} from "./resource";
import {
  parseSkill,
  type Skill,
  type SkillName,
  type SkillParseError
} from "./skill";

/**
 * Where skills are loaded from: a Computer Workspace, an R2 bucket, an
 * in-memory manifest, or a custom store.
 *
 * A source lists every skill it holds on each call, so changes show up the
 * next time a catalog is loaded. Expected failures are returned, not thrown.
 */
export interface SkillSource {
  /** Stable identifier used in diagnostics and duplicate-name warnings. */
  readonly id: string;
  /**
   * List the skills this source holds.
   *
   * @returns Valid skills and the skills that failed to parse, or
   * `SkillSourceError` when the store could not be read.
   */
  list(): Promise<SkillResult<SkillListing, SkillSourceError>>;
  /**
   * Read one file bundled with a skill.
   *
   * @param skill - The skill that owns the file.
   * @param path - Path relative to the skill directory.
   */
  readResource(
    skill: SkillName,
    path: SkillResourcePath
  ): Promise<
    SkillResult<SkillResource, SkillResourceNotFoundError | SkillSourceError>
  >;
}

/** Everything a source found in one {@link SkillSource.list} call. */
export interface SkillListing {
  /** Skills that parsed, in a stable order. */
  readonly skills: readonly ListedSkill[];
  /** Skills that did not follow the spec and were left out. */
  readonly invalid: readonly InvalidSkill[];
}

/** A valid skill and the files bundled with it. */
export interface ListedSkill {
  /** The parsed `SKILL.md`. */
  readonly skill: Skill;
  /** Files in the skill directory other than `SKILL.md`. */
  readonly resources: readonly SkillResourceInfo[];
  /**
   * Absolute directory of the skill in the agent's filesystem, when the
   * source stores skills there. Agents with a shell can run scripts from it.
   */
  readonly location?: string;
}

/** A skill that failed to parse. */
export interface InvalidSkill {
  /** Where the broken skill lives, such as `my-skill/SKILL.md`. */
  readonly location: string;
  /** Which spec rule it broke. */
  readonly error: SkillParseError;
}

/** A source's backing store failed. */
export class SkillSourceError extends Error {
  /** Stable tag for narrowing. */
  readonly _tag = "SkillSourceError" as const;

  /**
   * @param sourceId - The source that failed.
   * @param operation - What the source was doing.
   * @param cause - The underlying store error.
   */
  constructor(
    readonly sourceId: string,
    readonly operation: "list" | "read-resource",
    cause: unknown
  ) {
    super(
      `Skill source "${sourceId}" failed to ${operation === "list" ? "list skills" : "read a resource"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "SkillSourceError";
  }
}

/** A skill has no file at the requested path. */
export class SkillResourceNotFoundError extends Error {
  /** Stable tag for narrowing. */
  readonly _tag = "SkillResourceNotFoundError" as const;

  /**
   * @param skill - The skill that was searched.
   * @param path - The missing path.
   */
  constructor(
    readonly skill: SkillName,
    readonly path: string
  ) {
    super(`Resource not found: ${skill}/${path}`);
    this.name = "SkillResourceNotFoundError";
  }
}

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
      invalid.push({ location: skillPath, error: parsed.error });
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
