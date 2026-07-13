import { z } from "zod";
import { NotFoundError, toErrorValue } from "../../kernel/errors.js";
import { tool, type ToolSet } from "../tools/types.js";
import type { Workspace } from "../workspace/workspace.js";

export interface SkillResource {
  content: string;
  encoding: "utf8" | "base64";
  mediaType?: string;
}

export interface SkillDefinition {
  /** Directory name, unique. */
  name: string;
  /** From SKILL.md frontmatter. */
  description: string;
  /** SKILL.md body (markdown). */
  instructions: string;
  /** Relative path -> resource. */
  resources: Record<string, SkillResource>;
  metadata?: Record<string, unknown>;
}

export interface SkillSource {
  id: string;
  list(): Promise<SkillDefinition[]>;
}

export interface SkillRegistry {
  skills(): SkillDefinition[];
  get(name: string): SkillDefinition | undefined;
  warnings(): string[];
  /** Deterministic catalog block appended to the system prompt; "" when empty. */
  catalogBlock(): string;
  /** {} when there are no skills. */
  tools(): ToolSet;
}

const SKILL_MANIFEST = "SKILL.md";
const DEFAULT_WORKSPACE_PREFIX = "skills";

/** Static source: what a bundler plugin would emit. */
export function fromManifest(defs: SkillDefinition[]): SkillSource {
  return {
    id: "manifest",
    async list() {
      return defs;
    },
  };
}

/**
 * Reads `<prefix>/<skill>/SKILL.md` (+ sibling files as resources) out of a
 * workspace. Frontmatter is parsed with `parseFrontmatter`; `name` in the
 * frontmatter overrides the directory name, `description` defaults to "".
 */
export function fromWorkspace(ws: Workspace, prefix: string = DEFAULT_WORKSPACE_PREFIX): SkillSource {
  return {
    id: `workspace:${prefix}`,
    async list() {
      const manifestPaths = ws.find(`${prefix}/*/${SKILL_MANIFEST}`);
      const defs: SkillDefinition[] = [];

      for (const manifestPath of manifestPaths) {
        const rel = manifestPath.slice(prefix.length + 1);
        const dirName = rel.slice(0, rel.length - `/${SKILL_MANIFEST}`.length);
        const manifestFile = ws.read(manifestPath);
        if (!manifestFile) continue;

        const { attributes, body } = parseFrontmatter(manifestFile.content);
        const { name: attrName, description: attrDescription, ...rest } = attributes;

        const resources: Record<string, SkillResource> = {};
        const dirPrefix = `${prefix}/${dirName}/`;
        for (const entry of ws.list(`${prefix}/${dirName}`, { recursive: true })) {
          if (entry.path === manifestPath) continue;
          const resFile = ws.read(entry.path);
          if (!resFile) continue;
          const relPath = entry.path.slice(dirPrefix.length);
          resources[relPath] = {
            content: resFile.content,
            encoding: resFile.encoding,
            mediaType: resFile.mediaType,
          };
        }

        defs.push({
          name: attrName ?? dirName,
          description: attrDescription ?? "",
          instructions: body,
          resources,
          metadata: Object.keys(rest).length > 0 ? rest : undefined,
        });
      }

      return defs;
    },
  };
}

/**
 * Parses a minimal YAML-subset frontmatter block: `---\nkey: value\n...\n---`
 * followed by the markdown body. Top-level `key: value` strings only; quoted
 * values have their surrounding quotes stripped. Text without a well-formed
 * (opened AND closed) frontmatter block is returned unchanged as the body
 * with empty attributes.
 */
export function parseFrontmatter(md: string): { attributes: Record<string, string>; body: string } {
  const lines = md.split("\n");
  if (lines[0] !== "---") {
    return { attributes: {}, body: md };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { attributes: {}, body: md };
  }

  const attributes: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === "") continue;
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    attributes[key] = value;
  }

  const body = lines.slice(end + 1).join("\n");
  return { attributes, body };
}

function catalogBlockFor(defs: SkillDefinition[]): string {
  if (defs.length === 0) return "";
  const lines = defs.map((d) => `- ${d.name} — ${d.description}`);
  return [
    "## Skills",
    "",
    "These are on-demand instructions, not always-on prompt text. Call `activate_skill` with a skill's name to load its full instructions before using it.",
    "",
    ...lines,
  ].join("\n");
}

function toolsFor(skillMap: Map<string, SkillDefinition>, defs: SkillDefinition[]): ToolSet {
  if (defs.length === 0) return {};

  const activateSkill = tool({
    description: "Load the full instructions for a skill by name.",
    inputSchema: z.object({ name: z.string() }),
    execute(input) {
      const skill = skillMap.get(input.name);
      if (!skill) {
        const names = defs.map((d) => d.name).join(", ");
        return {
          error: toErrorValue(
            new NotFoundError(`Unknown skill "${input.name}". Valid skills: ${names}`)
          ),
        };
      }
      return skill.instructions;
    },
    metadata: { capability: "skills" },
  });

  const readSkillResource = tool({
    description:
      "Read a skill resource file. Pass { name, path } or a qualified \"skillname/relative/path\" in path alone.",
    inputSchema: z.object({ name: z.string().optional(), path: z.string() }),
    execute(input) {
      let name = input.name;
      let path = input.path;
      if (name === undefined) {
        const slash = path.indexOf("/");
        if (slash === -1) {
          return { error: toErrorValue(new NotFoundError(`Invalid qualified resource path "${path}"`)) };
        }
        name = path.slice(0, slash);
        path = path.slice(slash + 1);
      }

      const skill = skillMap.get(name);
      if (!skill) {
        const names = defs.map((d) => d.name).join(", ");
        return { error: toErrorValue(new NotFoundError(`Unknown skill "${name}". Valid skills: ${names}`)) };
      }

      const resource = skill.resources[path];
      if (!resource) {
        return { error: toErrorValue(new NotFoundError(`Unknown resource "${path}" in skill "${name}"`)) };
      }

      return { content: resource.content, encoding: resource.encoding, mediaType: resource.mediaType };
    },
    metadata: { capability: "skills" },
  });

  return { activate_skill: activateSkill, read_skill_resource: readSkillResource };
}

/**
 * Applies sources in order; first source to register a name wins (duplicates
 * skipped with a collected warning). A failing source (list() throws) is
 * skipped with a warning — the agent still starts.
 */
export async function createSkillRegistry(sources: SkillSource[]): Promise<SkillRegistry> {
  const skillMap = new Map<string, SkillDefinition>();
  const warnings: string[] = [];

  for (const source of sources) {
    let defs: SkillDefinition[];
    try {
      defs = await source.list();
    } catch (err) {
      warnings.push(`Skill source "${source.id}" failed: ${toErrorValue(err).message}`);
      continue;
    }
    for (const def of defs) {
      if (skillMap.has(def.name)) {
        warnings.push(`Duplicate skill "${def.name}" from source "${source.id}" ignored`);
        continue;
      }
      skillMap.set(def.name, def);
    }
  }

  const defs = [...skillMap.values()];

  return {
    skills() {
      return [...defs];
    },
    get(name) {
      return skillMap.get(name);
    },
    warnings() {
      return [...warnings];
    },
    catalogBlock() {
      return catalogBlockFor(defs);
    },
    tools() {
      return toolsFor(skillMap, defs);
    },
  };
}
