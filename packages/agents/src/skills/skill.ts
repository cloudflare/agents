import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { err, ok, type SkillResult } from "./result";

/**
 * Parsing for the Agent Skills `SKILL.md` format.
 *
 * Follows https://agentskills.io/specification: the required `name` and
 * `description` fields and the optional `license`, `compatibility`,
 * `metadata`, and `allowed-tools` fields are checked against the spec's
 * constraints. Other frontmatter keys are kept in {@link Skill.extraFields}
 * rather than rejected, because clients commonly add their own (for example
 * `disable-model-invocation`).
 *
 * @module
 */

declare const skillNameBrand: unique symbol;

/**
 * A skill name that satisfies the Agent Skills spec: 1-64 lowercase
 * alphanumeric characters and hyphens, with no leading, trailing, or
 * consecutive hyphens. Construct one with {@link parseSkillName}.
 */
export type SkillName = string & { readonly [skillNameBrand]: true };

/** Why a `SKILL.md` or skill field failed to parse. */
export type SkillParseErrorCode =
  | "missing-frontmatter"
  | "invalid-yaml"
  | "invalid-frontmatter"
  | "invalid-name"
  | "name-mismatch"
  | "invalid-description"
  | "invalid-license"
  | "invalid-compatibility"
  | "invalid-metadata"
  | "invalid-allowed-tools";

/** A `SKILL.md` that does not follow the Agent Skills spec. */
export class SkillParseError extends Error {
  /** Stable tag for narrowing. */
  readonly _tag = "SkillParseError" as const;

  /**
   * @param code - Which rule the skill broke.
   * @param message - Human-readable explanation, safe to show to a model.
   * @param options - The underlying cause, such as a YAML syntax error.
   */
  constructor(
    readonly code: SkillParseErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SkillParseError";
  }
}

/** A parsed Agent Skill: its frontmatter and Markdown instructions. */
export interface Skill {
  /** Spec-valid name; matches the skill's directory when it has one. */
  readonly name: SkillName;
  /** What the skill does and when to use it (1-1024 characters). */
  readonly description: string;
  /** License name or a reference to a bundled license file. */
  readonly license?: string;
  /** Environment requirements (1-500 characters). */
  readonly compatibility?: string;
  /** String key-value metadata. Empty when the skill declares none. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Pre-approved tools from `allowed-tools`. Experimental in the spec. */
  readonly allowedTools: readonly string[];
  /** Frontmatter keys the spec does not define, kept verbatim. */
  readonly extraFields: Readonly<Record<string, unknown>>;
  /** Markdown instructions after the frontmatter. */
  readonly body: string;
}

/** Options for {@link parseSkill}. */
export interface ParseSkillOptions {
  /**
   * Name of the directory that holds this `SKILL.md`. When set, the skill's
   * `name` must equal it, as the spec requires.
   */
  readonly directory?: string;
}

const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;
const COMPATIBILITY_MAX_LENGTH = 500;
const NAME_CHARACTERS = /^[\p{L}\p{N}-]+$/u;
const FRONTMATTER =
  /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;
const SPEC_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools"
]);

/**
 * Parse a skill name against the Agent Skills spec.
 *
 * The name is NFKC-normalized first. It must be 1-64 characters of
 * lowercase letters, digits, and hyphens, must not start or end with a
 * hyphen, and must not contain `--`.
 *
 * @param input - The candidate name.
 * @returns The branded name, or `SkillParseError` with code `invalid-name`.
 */
export function parseSkillName(
  input: string
): SkillResult<SkillName, SkillParseError> {
  const name = input.normalize("NFKC");
  const invalid = (reason: string) =>
    err(
      new SkillParseError(
        "invalid-name",
        `Invalid skill name "${input}": ${reason}.`
      )
    );

  if (name.length === 0) return invalid("it must not be empty");
  if ([...name].length > NAME_MAX_LENGTH) {
    return invalid(`it must be at most ${NAME_MAX_LENGTH} characters`);
  }
  if (name !== name.toLowerCase()) return invalid("it must be lowercase");
  if (!NAME_CHARACTERS.test(name)) {
    return invalid("it may only contain letters, digits, and hyphens");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return invalid("it must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    return invalid("it must not contain consecutive hyphens");
  }
  // SAFETY: every rule the SkillName brand promises was checked above.
  return ok(name as SkillName);
}

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
 * @internal Build a skill from already-decoded frontmatter. Sources that do
 * not start from a `SKILL.md` string (such as manifests) use this so every
 * skill passes the same rules.
 */
export function parseSkillFrontmatter(
  data: unknown,
  body: string,
  options: ParseSkillOptions = {}
): SkillResult<Skill, SkillParseError> {
  if (!isRecord(data)) {
    return err(
      new SkillParseError(
        "invalid-frontmatter",
        "SKILL.md frontmatter must be a YAML mapping."
      )
    );
  }

  if (typeof data.name !== "string") {
    return err(
      new SkillParseError(
        "invalid-name",
        "SKILL.md frontmatter must set `name` to a string."
      )
    );
  }
  const name = parseSkillName(data.name);
  if (!name.ok) return name;
  if (
    options.directory !== undefined &&
    options.directory.normalize("NFKC") !== name.value
  ) {
    return err(
      new SkillParseError(
        "name-mismatch",
        `Skill name "${name.value}" must match its directory "${options.directory}".`
      )
    );
  }

  const description = parseDescription(data.description);
  if (!description.ok) return description;
  const license = parseLicense(data.license);
  if (!license.ok) return license;
  const compatibility = parseCompatibility(data.compatibility);
  if (!compatibility.ok) return compatibility;
  const metadata = parseMetadata(data.metadata);
  if (!metadata.ok) return metadata;
  const allowedTools = parseAllowedTools(data["allowed-tools"]);
  if (!allowedTools.ok) return allowedTools;

  const extraFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SPEC_FIELDS.has(key)) extraFields[key] = value;
  }

  return ok({
    name: name.value,
    description: description.value,
    ...(license.value === undefined ? {} : { license: license.value }),
    ...(compatibility.value === undefined
      ? {}
      : { compatibility: compatibility.value }),
    metadata: metadata.value,
    allowedTools: allowedTools.value,
    extraFields,
    body
  });
}

/**
 * Whether a model may activate this skill on its own. Skills opt out with
 * `disable-model-invocation: true`, as a top-level field or in `metadata`.
 *
 * @param skill - The parsed skill.
 * @returns `false` when the skill disables model invocation.
 */
export function isModelInvocable(skill: Skill): boolean {
  return (
    skill.extraFields["disable-model-invocation"] !== true &&
    skill.metadata["disable-model-invocation"] !== "true"
  );
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

function parseDescription(
  value: unknown
): SkillResult<string, SkillParseError> {
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length === 0) {
    return err(
      new SkillParseError(
        "invalid-description",
        "SKILL.md frontmatter must set `description` to a non-empty string."
      )
    );
  }
  if ([...description].length > DESCRIPTION_MAX_LENGTH) {
    return err(
      new SkillParseError(
        "invalid-description",
        `Skill description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`
      )
    );
  }
  return ok(description);
}

function parseLicense(
  value: unknown
): SkillResult<string | undefined, SkillParseError> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "string" || value.trim().length === 0) {
    return err(
      new SkillParseError(
        "invalid-license",
        "Skill `license` must be a non-empty string."
      )
    );
  }
  return ok(value.trim());
}

function parseCompatibility(
  value: unknown
): SkillResult<string | undefined, SkillParseError> {
  if (value === undefined || value === null) return ok(undefined);
  const compatibility = typeof value === "string" ? value.trim() : "";
  if (
    compatibility.length === 0 ||
    [...compatibility].length > COMPATIBILITY_MAX_LENGTH
  ) {
    return err(
      new SkillParseError(
        "invalid-compatibility",
        `Skill \`compatibility\` must be 1-${COMPATIBILITY_MAX_LENGTH} characters.`
      )
    );
  }
  return ok(compatibility);
}

/**
 * The spec defines `metadata` as a string-to-string map. YAML turns
 * unquoted values such as `version: 1.0` into numbers, so scalar values are
 * converted to strings rather than rejected; nested values are an error.
 */
function parseMetadata(
  value: unknown
): SkillResult<Readonly<Record<string, string>>, SkillParseError> {
  if (value === undefined || value === null) return ok({});
  if (!isRecord(value)) {
    return err(
      new SkillParseError(
        "invalid-metadata",
        "Skill `metadata` must be a mapping of string keys to string values."
      )
    );
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      return err(
        new SkillParseError(
          "invalid-metadata",
          `Skill \`metadata.${key}\` must be a string.`
        )
      );
    }
    metadata[key] = String(entry);
  }
  return ok(metadata);
}

/**
 * The spec defines `allowed-tools` as a space-separated string. A YAML list
 * of strings is also accepted, since some clients write it that way.
 */
function parseAllowedTools(
  value: unknown
): SkillResult<readonly string[], SkillParseError> {
  if (value === undefined || value === null) return ok([]);
  if (typeof value === "string") {
    return ok(value.split(/\s+/).filter((tool) => tool.length > 0));
  }
  if (
    Array.isArray(value) &&
    value.every((tool): tool is string => typeof tool === "string")
  ) {
    return ok(value.map((tool) => tool.trim()).filter(Boolean));
  }
  return err(
    new SkillParseError(
      "invalid-allowed-tools",
      "Skill `allowed-tools` must be a space-separated string."
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
