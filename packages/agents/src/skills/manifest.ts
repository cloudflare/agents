import { err, ok } from "./result";
import {
  describeSkillResource,
  parseSkillResourcePath,
  type SkillResource,
  type SkillResourceInfo,
  type SkillResourceKind
} from "./resource";
import { parseSkillFrontmatter } from "./skill";
import {
  SkillResourceNotFoundError,
  type InvalidSkill,
  type ListedSkill,
  type SkillListing,
  type SkillSource
} from "./source";

/** Skills defined in code, for tests and small fixed sets. */
export interface SkillManifest {
  /** Source id used in diagnostics. */
  readonly id: string;
  /** The skills, in priority order. */
  readonly skills: readonly SkillManifestEntry[];
  /**
   * @deprecated Ignored. Catalogs fingerprint the prompt they render, so
   * sources no longer carry a fingerprint.
   */
  readonly fingerprint?: string;
}

/** One skill in a {@link SkillManifest}, written as `SKILL.md` fields. */
export interface SkillManifestEntry {
  /** Spec-valid skill name. */
  readonly name: string;
  /** What the skill does and when to use it. */
  readonly description: string;
  /** Markdown instructions. */
  readonly body: string;
  /** License name or bundled license file. */
  readonly license?: string;
  /** Environment requirements. */
  readonly compatibility?: string;
  /**
   * String key-value metadata. Scalar values are converted to strings, as
   * in `SKILL.md`; nested values make the entry invalid.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Space-separated pre-approved tools. */
  readonly allowedTools?: string;
  /** Files bundled with the skill. */
  readonly resources?: readonly SkillManifestResource[];
  /** @deprecated Ignored. */
  readonly version?: string;
  /** @deprecated Ignored; the entry fields define the skill. */
  readonly rawContent?: string;
}

/** A file in a {@link SkillManifestEntry}. */
export interface SkillManifestResource {
  /** Path relative to the skill directory. */
  readonly path: string;
  /** UTF-8 text, or base64 when `encoding` is `"base64"`. */
  readonly content: string;
  /** Overrides the encoding inferred from the file extension. */
  readonly encoding?: "text" | "base64";
  /** Overrides the MIME type inferred from the file extension. */
  readonly mimeType?: string;
  /** Overrides the kind inferred from the top-level directory. */
  readonly kind?: SkillResourceKind;
  /** @deprecated Ignored; the size is the content's length. */
  readonly size?: number;
  /** @deprecated Ignored; scripts are always run as stored. */
  readonly precompiled?: boolean;
}

/**
 * Create a source from skills defined in code.
 *
 * Entries pass the same checks as `SKILL.md` files from other sources:
 * broken spec rules become warnings, and entries without a usable
 * name or description are reported as invalid. Useful for tests and for small fixed skill sets
 * that do not need a Workspace or bucket.
 *
 * @param definition - The skills to serve.
 * @returns A source that always lists the same skills.
 */
export function manifest(definition: SkillManifest): SkillSource {
  const contents = new Map<string, Map<string, SkillResource>>();
  const skills: ListedSkill[] = [];
  const invalid: InvalidSkill[] = [];

  for (const entry of definition.skills) {
    const parsed = parseSkillFrontmatter(
      {
        name: entry.name,
        description: entry.description,
        license: entry.license,
        compatibility: entry.compatibility,
        metadata: entry.metadata,
        "allowed-tools": entry.allowedTools
      },
      entry.body
    );
    if (!parsed.ok) {
      invalid.push({
        location: `${definition.id}:${entry.name}`,
        error: parsed.error
      });
      continue;
    }
    if (contents.has(parsed.value.name)) continue;

    const files = new Map<string, SkillResource>();
    const resources: SkillResourceInfo[] = [];
    for (const resource of entry.resources ?? []) {
      const path = parseSkillResourcePath(resource.path);
      if (!path.ok) continue;
      const inferred = describeSkillResource(path.value);
      const info: SkillResourceInfo = {
        ...inferred,
        kind: resource.kind ?? inferred.kind,
        encoding: resource.encoding ?? inferred.encoding,
        ...(resource.mimeType === undefined
          ? {}
          : { mimeType: resource.mimeType })
      };
      resources.push(info);
      files.set(path.value, { ...info, content: resource.content });
    }
    resources.sort((a, b) => a.path.localeCompare(b.path));
    contents.set(parsed.value.name, files);
    skills.push({
      skill: parsed.value,
      resources,
      ...(parsed.warnings.length === 0 ? {} : { warnings: parsed.warnings })
    });
  }

  const listing: SkillListing = { skills, invalid };
  return {
    id: definition.id,
    async list() {
      return ok(listing);
    },
    async readResource(skill, path) {
      const resource = contents.get(skill)?.get(path);
      return resource
        ? ok(resource)
        : err(new SkillResourceNotFoundError(skill, path));
    }
  };
}

/**
 * Create a source from skills defined in code.
 *
 * @deprecated Use {@link manifest}.
 * @param definition - The skills to serve.
 * @returns A source that always lists the same skills.
 */
export const fromManifest = manifest;
