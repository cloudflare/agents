import { err, ok, type SkillResult } from "./result";
import {
  InvalidSkillResourcePathError,
  parseSkillResourcePath,
  type SkillResource,
  type SkillResourceInfo
} from "./resource";
import { isModelInvocable, type Skill, type SkillParseError } from "./skill";
import {
  SkillResourceNotFoundError,
  SkillSourceError,
  type SkillSource
} from "./source";

/**
 * The skills an agent can use right now, merged from its sources.
 *
 * Load one with {@link loadSkillCatalog}; load it again to pick up changes.
 * Framework adapters (Think's AI SDK tools, the pi `skills()` extension)
 * wrap a catalog so every framework shows the model the same catalog text,
 * activation output, and resource output.
 */
export interface SkillCatalog {
  /** Changes whenever {@link prompt} would change. */
  readonly fingerprint: string;
  /** Skills the model may activate, in source priority order. */
  readonly skills: readonly SkillCatalogEntry[];
  /** Problems found while loading: invalid skills, failed sources, duplicates. */
  readonly diagnostics: readonly SkillDiagnostic[];
  /**
   * System-prompt text listing each skill's name and description.
   *
   * @returns The catalog prompt, or `null` when there are no skills.
   */
  prompt(): string | null;
  /**
   * Find a skill by name.
   *
   * @param name - Skill name.
   * @returns The entry, or `undefined` when the catalog has no such skill.
   */
  find(name: string): SkillCatalogEntry | undefined;
  /**
   * Render a skill's instructions and resource list for the model.
   *
   * @param name - Skill name.
   */
  activate(name: string): SkillResult<string, UnknownSkillError>;
  /**
   * Read a bundled file.
   *
   * @param request - Either `name` and a skill-relative `path`, or a
   * qualified `path` such as `my-skill/references/guide.md`.
   */
  readResource(request: {
    readonly name?: string;
    readonly path: string;
  }): Promise<SkillResult<SkillCatalogResource, SkillResourceError>>;
}

/** A skill in a {@link SkillCatalog}. */
export interface SkillCatalogEntry {
  /** The parsed skill. */
  readonly skill: Skill;
  /** Id of the source that provided it. */
  readonly sourceId: string;
  /** Files bundled with the skill. */
  readonly resources: readonly SkillResourceInfo[];
  /** Absolute directory in the agent's filesystem, when the source has one. */
  readonly location?: string;
}

/** A resource read through a {@link SkillCatalog}. */
export interface SkillCatalogResource {
  /** The skill that owns the resource. */
  readonly entry: SkillCatalogEntry;
  /** The resource and its content. */
  readonly resource: SkillResource;
}

/** Why {@link SkillCatalog.readResource} failed. */
export type SkillResourceError =
  | UnknownSkillError
  | InvalidSkillResourcePathError
  | SkillResourceNotFoundError
  | SkillSourceError;

/** A problem found while loading a catalog. Never fatal. */
export type SkillDiagnostic =
  | {
      /** A `SKILL.md` broke a spec rule and was skipped. */
      readonly _tag: "InvalidSkill";
      readonly sourceId: string;
      readonly location: string;
      readonly error: SkillParseError;
    }
  | {
      /** A source could not be listed and was skipped. */
      readonly _tag: "SourceFailed";
      readonly sourceId: string;
      readonly error: SkillSourceError;
    }
  | {
      /** A later source listed a name an earlier source already provided. */
      readonly _tag: "DuplicateSkill";
      readonly name: string;
      readonly sourceId: string;
      readonly keptSourceId: string;
    };

/** The catalog has no skill with the requested name. */
export class UnknownSkillError extends Error {
  /** Stable tag for narrowing. */
  readonly _tag = "UnknownSkillError" as const;

  /** @param skill - The requested name. */
  constructor(readonly skill: string) {
    super(`Skill not found: ${skill}`);
    this.name = "UnknownSkillError";
  }
}

/**
 * Load every source and merge them into a catalog.
 *
 * Sources apply in order: the first source to list a name wins. A failing
 * source or an invalid skill becomes a diagnostic instead of an error, so
 * one bad source never hides the others. Skills that set
 * `disable-model-invocation: true` are left out.
 *
 * @param sources - Skill sources in priority order.
 * @returns The merged catalog.
 */
export async function loadSkillCatalog(
  sources: readonly SkillSource[]
): Promise<SkillCatalog> {
  // Custom sources should return failures, but one that throws must still
  // not hide the others.
  const listings = await Promise.all(
    sources.map(async (source) => ({
      source,
      listed: await source
        .list()
        .catch((cause: unknown) =>
          err(new SkillSourceError(source.id, "list", cause))
        )
    }))
  );

  const diagnostics: SkillDiagnostic[] = [];
  const entries = new Map<string, SkillCatalogEntry>();
  const sourcesById = new Map<string, SkillSource>();

  for (const { source, listed } of listings) {
    if (!listed.ok) {
      diagnostics.push({
        _tag: "SourceFailed",
        sourceId: source.id,
        error: listed.error
      });
      continue;
    }
    sourcesById.set(source.id, source);
    for (const invalid of listed.value.invalid) {
      diagnostics.push({
        _tag: "InvalidSkill",
        sourceId: source.id,
        location: invalid.location,
        error: invalid.error
      });
    }
    for (const { skill, resources, location } of listed.value.skills) {
      const existing = entries.get(skill.name);
      if (existing) {
        diagnostics.push({
          _tag: "DuplicateSkill",
          name: skill.name,
          sourceId: source.id,
          keptSourceId: existing.sourceId
        });
        continue;
      }
      entries.set(skill.name, {
        skill,
        sourceId: source.id,
        resources,
        ...(location === undefined ? {} : { location })
      });
    }
  }

  const skills = [...entries.values()].filter((entry) =>
    isModelInvocable(entry.skill)
  );
  const visible = new Map<string, SkillCatalogEntry>(
    skills.map((entry) => [entry.skill.name, entry])
  );
  const prompt = renderCatalogPrompt(skills);

  return {
    fingerprint: fingerprintOf(prompt ?? ""),
    skills,
    diagnostics,
    prompt: () => prompt,
    find: (name) => visible.get(name),
    activate(name) {
      const entry = visible.get(name);
      return entry
        ? ok(renderSkillActivation(entry))
        : err(new UnknownSkillError(name));
    },
    async readResource(request) {
      const target = resolveResourceTarget(visible, request);
      if (!target.ok) return target;
      const { entry, path } = target.value;
      const source = sourcesById.get(entry.sourceId);
      if (!source) return err(new UnknownSkillError(entry.skill.name));
      const read = await source
        .readResource(entry.skill.name, path)
        .catch((cause: unknown) =>
          err(new SkillSourceError(source.id, "read-resource", cause))
        );
      if (!read.ok) return read;
      return ok({ entry, resource: read.value });
    }
  };
}

/**
 * Describe a diagnostic in one line, for logs.
 *
 * @param diagnostic - A diagnostic from {@link SkillCatalog.diagnostics}.
 */
export function formatSkillDiagnostic(diagnostic: SkillDiagnostic): string {
  switch (diagnostic._tag) {
    case "InvalidSkill":
      return `Skipped invalid skill ${diagnostic.location} from source "${diagnostic.sourceId}": ${diagnostic.error.message}`;
    case "SourceFailed":
      return `${diagnostic.error.message}. Its skills were skipped.`;
    case "DuplicateSkill":
      return `Duplicate skill "${diagnostic.name}" from source "${diagnostic.sourceId}" ignored; already provided by "${diagnostic.keptSourceId}".`;
  }
}

/**
 * Render a resource read for the model.
 *
 * @param read - A resource returned by {@link SkillCatalog.readResource}.
 */
export function renderSkillResource(read: SkillCatalogResource): string {
  const { entry, resource } = read;
  return [
    `<skill_resource${attributes([
      ["name", entry.skill.name],
      ["path", resource.path],
      ["kind", resource.kind],
      ["encoding", resource.encoding],
      ["mimeType", resource.mimeType]
    ])}>`,
    resource.content,
    "</skill_resource>"
  ].join("\n");
}

function renderCatalogPrompt(
  skills: readonly SkillCatalogEntry[]
): string | null {
  if (skills.length === 0) return null;
  return [
    "Available skills. When a task matches a skill, use activate_skill with its name before proceeding.",
    "",
    ...skills.map(
      ({ skill }) =>
        `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`
    )
  ].join("\n");
}

function renderSkillActivation(entry: SkillCatalogEntry): string {
  const lines = [
    `<skill_content${attributes([
      ["name", entry.skill.name],
      ["location", entry.location]
    ])}>`,
    entry.skill.body.trim()
  ];
  if (entry.resources.length > 0) {
    lines.push("", "<skill_resources>");
    for (const resource of entry.resources) {
      lines.push(
        `  <file${attributes([
          ["kind", resource.kind],
          ["encoding", resource.encoding],
          [
            "size",
            resource.size === undefined ? undefined : String(resource.size)
          ]
        ])}>${resource.path}</file>`
      );
    }
    lines.push("</skill_resources>");
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

function resolveResourceTarget(
  skills: ReadonlyMap<string, SkillCatalogEntry>,
  request: { readonly name?: string; readonly path: string }
): SkillResult<
  {
    entry: SkillCatalogEntry;
    path: SkillResourceInfo["path"];
  },
  UnknownSkillError | InvalidSkillResourcePathError | SkillResourceNotFoundError
> {
  let name = request.name;
  let relative = request.path;
  if (name === undefined) {
    const slash = relative.indexOf("/");
    if (slash <= 0) return err(new InvalidSkillResourcePathError(relative));
    name = relative.slice(0, slash);
    relative = relative.slice(slash + 1);
  }
  const entry = skills.get(name);
  if (!entry) return err(new UnknownSkillError(name));
  const path = parseSkillResourcePath(relative);
  if (!path.ok) return path;
  // Only files the source listed are readable, whatever the source's store
  // holds beside them.
  if (!entry.resources.some((resource) => resource.path === path.value)) {
    return err(new SkillResourceNotFoundError(entry.skill.name, path.value));
  }
  return ok({ entry, path: path.value });
}

function attributes(
  pairs: ReadonlyArray<readonly [string, string | undefined]>
): string {
  return pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
    .map(([key, value]) => ` ${key}="${value.replace(/"/g, "&quot;")}"`)
    .join("");
}

/** Two FNV-1a passes with different seeds: cheap and stable across isolates. */
function fingerprintOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
