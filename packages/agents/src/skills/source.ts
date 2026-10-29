import type { SkillResult } from "./result";
import type {
  SkillResource,
  SkillResourceInfo,
  SkillResourcePath
} from "./resource";
import type { Skill, SkillName, SkillParseError } from "./skill";

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
  /**
   * Spec rules the skill breaks but was loaded anyway, for example a name
   * that does not match its directory, as the spec's guide for agents
   * recommends.
   */
  readonly warnings?: readonly SkillParseError[];
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
