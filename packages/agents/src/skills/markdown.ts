import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { err, type SkillResult } from "./result";
import {
  parseSkillFrontmatter,
  SkillParseError,
  type ParseSkillOptions,
  type Skill
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
 * @param markdown - The full file: YAML frontmatter, then Markdown.
 * @param options - Pass `directory` to enforce that `name` matches it.
 * @returns The parsed skill, or a `SkillParseError` naming the broken rule.
 */
export function parseSkill(
  markdown: string,
  options: ParseSkillOptions = {}
): SkillResult<Skill, SkillParseError> {
  const match = FRONTMATTER.exec(markdown);
  if (!match) {
    return err(
      new SkillParseError(
        "missing-frontmatter",
        "SKILL.md must start with YAML frontmatter between --- lines."
      )
    );
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (cause) {
    return err(
      new SkillParseError(
        "invalid-yaml",
        `SKILL.md frontmatter is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      )
    );
  }

  return parseSkillFrontmatter(data ?? {}, match[2] ?? "", options);
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
