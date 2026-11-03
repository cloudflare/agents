import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { err, ok, type SkillResult } from "./result";
import {
  parseSkillFrontmatter,
  SkillParseError,
  type ParseSkillOptions,
  type Skill,
  type SkillParseResult
} from "./skill";

/**
 * `SKILL.md` text: YAML frontmatter between `---` lines, then Markdown.
 * Kept apart from `./skill` because it loads the YAML parser.
 *
 * @module
 */

const FRONTMATTER =
  /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Parse a `SKILL.md` file.
 *
 * Follows the spec's guide for agents: a skill that breaks a rule still
 * parses, with each broken rule in `warnings`. Frontmatter that only fails
 * because of unquoted values containing `: ` (for example
 * `description: Use when: the user asks`), which many clients accept, is
 * read again with those values quoted. The parse fails only when the skill
 * cannot be used: no frontmatter, YAML that still does not parse, no
 * description, or an unsafe name.
 *
 * To check a skill before storing it, require `warnings` to be empty.
 *
 * @param markdown - The full file: YAML frontmatter, then Markdown.
 * @param options - `directory` to check the name against.
 * @returns The parsed skill and warnings, or a `SkillParseError`.
 */
export function parseSkill(
  markdown: string,
  options: ParseSkillOptions = {}
): SkillParseResult {
  const match = FRONTMATTER.exec(markdown);
  if (!match) {
    return err(
      new SkillParseError(
        "missing-frontmatter",
        "SKILL.md must start with YAML frontmatter between --- lines."
      )
    );
  }

  const yaml = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = parseFrontmatterYaml(yaml);
  if (parsed.ok) {
    return parseSkillFrontmatter(parsed.value ?? {}, body, options);
  }
  const repaired = parseFrontmatterYaml(quoteColonValues(yaml));
  if (!repaired.ok) return parsed;
  const result = parseSkillFrontmatter(repaired.value ?? {}, body, options);
  return result.ok
    ? {
        ...result,
        warnings: [
          new SkillParseError(
            "invalid-yaml",
            "SKILL.md frontmatter is not valid YAML; it was read after quoting values that contain `: `.",
            { cause: parsed.error.cause }
          ),
          ...result.warnings
        ]
      }
    : result;
}

function parseFrontmatterYaml(
  yaml: string
): SkillResult<unknown, SkillParseError> {
  try {
    return ok(parseYaml(yaml));
  } catch (cause) {
    return err(
      new SkillParseError(
        "invalid-yaml",
        `SKILL.md frontmatter is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      )
    );
  }
}

/**
 * Quote top-level `key: value` lines whose value contains `: `, the most
 * common way hand-written frontmatter breaks YAML. Values that are already
 * quoted, block scalars, or flow collections are left alone.
 */
function quoteColonValues(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([A-Za-z0-9_-]+):[ \t]+(.+)$/.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      if (value === undefined || !value.includes(": ")) return line;
      if (/^["'|>[{&*!]/.test(value)) return line;
      return `${key}: ${JSON.stringify(value.trim())}`;
    })
    .join("\n");
}

/**
 * Render a skill back to `SKILL.md` text.
 *
 * @param skill - The parsed skill.
 * @returns Frontmatter and body that {@link parseSkill} reads back to an
 * equal skill.
 */
export function formatSkill(skill: Skill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    ...(skill.license === undefined ? {} : { license: skill.license }),
    ...(skill.compatibility === undefined
      ? {}
      : { compatibility: skill.compatibility }),
    ...(Object.keys(skill.metadata).length === 0
      ? {}
      : { metadata: skill.metadata }),
    ...(skill.allowedTools.length === 0
      ? {}
      : { "allowed-tools": skill.allowedTools.join(" ") }),
    ...skill.extraFields
  };
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${skill.body}`;
}
