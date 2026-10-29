import { err, ok, type SkillResult } from "./result";
import {
  describeSkillResource,
  encodeSkillResourceContent,
  type SkillResource
} from "./resource";
import {
  SkillResourceNotFoundError,
  SkillSourceError,
  type SkillListing,
  type SkillSource
} from "./source";
import { indexSkillTree, type SkillTreeFile } from "./tree";

/** Options for {@link r2}. */
export interface R2SkillSourceOptions {
  /** Key prefix that holds the skill directories, such as `skills/`. */
  readonly prefix?: string;
  /** Source id for diagnostics. Defaults to `r2:<prefix>`. */
  readonly id?: string;
  /** Only serve these skill names. Serves every skill when omitted. */
  readonly skills?: readonly string[];
  /**
   * How long a bucket listing is reused before the bucket is listed again.
   * Defaults to 60 seconds; `0` lists on every call.
   */
  readonly refreshIntervalMs?: number;
}

/**
 * Create a read-only source backed by an R2 bucket.
 *
 * The bucket holds the Agent Skills layout under `prefix`:
 * `<prefix><skill-name>/SKILL.md`, plus any bundled files beside it.
 *
 * @param bucket - The R2 binding.
 * @param options - Prefix, id, name allowlist, and listing cache interval.
 * @returns A source that reads skills from the bucket.
 */
export function r2(
  bucket: R2Bucket,
  options: R2SkillSourceOptions = {}
): SkillSource {
  const prefix = normalizePrefix(options.prefix);
  const id = options.id ?? `r2:${prefix || "/"}`;
  const allowed = options.skills?.length ? new Set(options.skills) : null;
  const refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
  let cached: { listing: SkillListing; at: number } | null = null;

  async function list(): Promise<SkillResult<SkillListing, SkillSourceError>> {
    if (cached && Date.now() - cached.at < refreshIntervalMs) {
      return ok(cached.listing);
    }
    try {
      const files: SkillTreeFile[] = (await listAll(bucket, prefix)).map(
        (object) => ({
          path: object.key.slice(prefix.length),
          size: object.size
        })
      );
      const listing = await indexSkillTree(files, async (path) => {
        const object = await bucket.get(`${prefix}${path}`);
        return object ? object.text() : null;
      });
      const filtered: SkillListing = allowed
        ? {
            skills: listing.skills.filter(({ skill }) =>
              allowed.has(skill.name)
            ),
            invalid: listing.invalid.filter(
              (skill) => skill.name === undefined || allowed.has(skill.name)
            )
          }
        : listing;
      cached = { listing: filtered, at: Date.now() };
      return ok(filtered);
    } catch (cause) {
      return err(new SkillSourceError(id, "list", cause));
    }
  }

  return {
    id,
    list,
    // Reads go straight to the object. Relisting the bucket here would
    // cost a full scan per file, and `run_skill_script` reads every file
    // of a skill.
    async readResource(skill, path) {
      if (allowed && !allowed.has(skill)) {
        return err(new SkillResourceNotFoundError(skill, path));
      }
      try {
        // A valid skill's name is its directory.
        const object = await bucket.get(`${prefix}${skill}/${path}`);
        if (!object) return err(new SkillResourceNotFoundError(skill, path));
        const info = describeSkillResource(path, object.size);
        const bytes = new Uint8Array(await object.arrayBuffer());
        const resource: SkillResource = {
          ...info,
          content: encodeSkillResourceContent(bytes, info.encoding)
        };
        return ok(resource);
      } catch (cause) {
        return err(new SkillSourceError(id, "read-resource", cause));
      }
    }
  };
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

async function listAll(
  bucket: R2Bucket,
  prefix: string
): Promise<Array<{ key: string; size: number }>> {
  const objects: Array<{ key: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(
      ...page.objects.map((object) => ({ key: object.key, size: object.size }))
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
