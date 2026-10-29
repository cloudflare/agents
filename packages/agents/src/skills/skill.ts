import { err, ok, type SkillResult } from "./result";

/**
 * The Agent Skills `Skill` type and its frontmatter rules. `SKILL.md`
 * text parsing lives in `./markdown` so code that only handles parsed
 * skills does not load the YAML parser.
 *
 * The rules come from https://agentskills.io/specification and are always
 * applied strictly: a skill that breaks any rule fails to parse, with every
 * broken rule listed in {@link SkillParseError.issues}. Validate skills when
 * they are written; sources parse them again on every read, and an agent
 * that activates a broken skill gets the validation error as the tool
 * result, so it (or its author) can fix the file.
 *
 * Frontmatter keys the spec does not define are kept in
 * {@link Skill.extraFields}, because clients commonly add their own.
 *
 * @module
 */

declare const skillNameBrand: unique symbol;

/**
 * A skill name that follows the Agent Skills spec: 1-64 lowercase letters,
 * digits, and hyphens, with no leading, trailing, or consecutive hyphens.
 * Construct one with {@link parseSkillName} or {@link parseSkill}.
 */
export type SkillName = string & { readonly [skillNameBrand]: true };

/** Why a `SKILL.md` or skill field broke a rule. */
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

/** One broken rule in a `SKILL.md`. */
export interface SkillParseIssue {
  /** Which rule. */
  readonly code: SkillParseErrorCode;
  /** Human-readable explanation, safe to show to a model. */
  readonly message: string;
}

/**
 * A `SKILL.md` that breaks one or more Agent Skills rules. `code` is the
 * first broken rule; `issues` lists all of them, so an author can fix the
 * file in one pass.
 */
export class SkillParseError extends Error {
  /** Stable tag for narrowing. */
  readonly _tag = "SkillParseError" as const;
  /** Every broken rule, in field order. Always has at least one entry. */
  readonly issues: readonly SkillParseIssue[];

  /**
   * @param code - The first rule the skill broke.
   * @param message - Human-readable explanation, safe to show to a model.
   * @param options - Every issue when there is more than one, and the
   * underlying cause, such as a YAML syntax error.
   */
  constructor(
    readonly code: SkillParseErrorCode,
    message: string,
    options?: { cause?: unknown; issues?: readonly SkillParseIssue[] }
  ) {
    super(message, options);
    this.name = "SkillParseError";
    this.issues = options?.issues ?? [{ code, message }];
  }
}

/** A parsed Agent Skill: its frontmatter and Markdown instructions. */
export interface Skill {
  /** The skill's name. */
  readonly name: SkillName;
  /** What the skill does and when to use it. */
  readonly description: string;
  /** License name or a reference to a bundled license file. */
  readonly license?: string;
  /** Environment requirements. */
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
   * Name of the directory that holds this `SKILL.md`. The spec requires the
   * skill's `name` to match it.
   */
  readonly directory?: string;
}

const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;
const COMPATIBILITY_MAX_LENGTH = 500;
const NAME_CHARACTERS = /^[\p{L}\p{N}-]+$/u;
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
  const problem = specNameProblem(name);
  if (problem !== null) {
    return err(
      new SkillParseError(
        "invalid-name",
        `Invalid skill name "${input}": ${problem}.`
      )
    );
  }
  // SAFETY: specNameProblem checked every rule the SkillName brand promises.
  return ok(name as SkillName);
}

/** A field value, or the rules it broke. */
type Field<T> =
  | { readonly value: T; readonly problems?: readonly SkillParseError[] }
  | {
      readonly fatal: SkillParseError;
      readonly problems?: readonly SkillParseError[];
    };

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

  // Every field is checked, so the error lists every broken rule.
  const issues: SkillParseIssue[] = [];
  function take<T>(field: Field<T>): T | undefined {
    if ("fatal" in field) issues.push(issueOf(field.fatal));
    issues.push(...(field.problems ?? []).map(issueOf));
    return "fatal" in field ? undefined : field.value;
  }

  const name = take(parseName(data.name, options.directory));
  const description = take(parseDescription(data.description));
  const license = take(parseLicense(data.license));
  const compatibility = take(parseCompatibility(data.compatibility));
  const metadata = take(parseMetadata(data.metadata));
  const allowedTools = take(parseAllowedTools(data["allowed-tools"]));
  const [first] = issues;
  if (first) {
    return err(
      new SkillParseError(
        first.code,
        issues.length === 1
          ? first.message
          : `SKILL.md breaks ${issues.length} rules: ${issues.map((issue) => issue.message).join(" ")}`,
        { issues }
      )
    );
  }
  if (
    name === undefined ||
    description === undefined ||
    metadata === undefined ||
    allowedTools === undefined
  ) {
    return err(
      new SkillParseError("invalid-frontmatter", "Invalid frontmatter.")
    );
  }

  const extraFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SPEC_FIELDS.has(key)) extraFields[key] = value;
  }

  return ok({
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    metadata,
    allowedTools,
    extraFields,
    body
  });
}

function issueOf(error: SkillParseError): SkillParseIssue {
  return { code: error.code, message: error.message };
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

/** Why a name breaks the spec format, or `null` when it follows it. */
function specNameProblem(name: string): string | null {
  if (name.length === 0) return "it must not be empty";
  if ([...name].length > NAME_MAX_LENGTH) {
    return `it must be at most ${NAME_MAX_LENGTH} characters`;
  }
  if (name !== name.toLowerCase()) return "it must be lowercase";
  if (!NAME_CHARACTERS.test(name)) {
    return "it may only contain letters, digits, and hyphens";
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return "it must not start or end with a hyphen";
  }
  if (name.includes("--")) return "it must not contain consecutive hyphens";
  return null;
}

function parseName(
  value: unknown,
  directory: string | undefined
): Field<SkillName> {
  if (typeof value !== "string") {
    return {
      fatal: new SkillParseError(
        "invalid-name",
        "SKILL.md frontmatter must set `name` to a string."
      )
    };
  }
  // The directory check runs whether or not the format is valid, so a
  // name that breaks both rules reports both.
  const mismatch =
    directory !== undefined &&
    directory.normalize("NFKC") !== value.normalize("NFKC")
      ? [
          new SkillParseError(
            "name-mismatch",
            `Skill name "${value}" must match its directory "${directory}".`
          )
        ]
      : [];
  const parsed = parseSkillName(value);
  if (!parsed.ok) return { fatal: parsed.error, problems: mismatch };
  return mismatch.length === 0
    ? { value: parsed.value }
    : { value: parsed.value, problems: mismatch };
}

function parseDescription(value: unknown): Field<string> {
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length === 0) {
    return {
      fatal: new SkillParseError(
        "invalid-description",
        "SKILL.md frontmatter must set `description` to a non-empty string."
      )
    };
  }
  if ([...description].length > DESCRIPTION_MAX_LENGTH) {
    return {
      value: description,
      problems: [
        new SkillParseError(
          "invalid-description",
          `Skill description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`
        )
      ]
    };
  }
  return { value: description };
}

function parseLicense(value: unknown): Field<string | undefined> {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      value: undefined,
      problems: [
        new SkillParseError(
          "invalid-license",
          "Skill `license` must be a non-empty string."
        )
      ]
    };
  }
  return { value: value.trim() };
}

function parseCompatibility(value: unknown): Field<string | undefined> {
  if (value === undefined || value === null) return { value: undefined };
  const compatibility = typeof value === "string" ? value.trim() : "";
  if (
    compatibility.length === 0 ||
    [...compatibility].length > COMPATIBILITY_MAX_LENGTH
  ) {
    return {
      value: compatibility.length === 0 ? undefined : compatibility,
      problems: [
        new SkillParseError(
          "invalid-compatibility",
          `Skill \`compatibility\` must be 1-${COMPATIBILITY_MAX_LENGTH} characters.`
        )
      ]
    };
  }
  return { value: compatibility };
}

/**
 * The spec defines `metadata` as a string-to-string map. YAML turns
 * unquoted values such as `version: 1.0` into numbers, so scalar values are
 * converted to strings rather than rejected. Nested values break the rule.
 */
function parseMetadata(
  value: unknown
): Field<Readonly<Record<string, string>>> {
  if (value === undefined || value === null) return { value: {} };
  if (!isRecord(value)) {
    return {
      value: {},
      problems: [
        new SkillParseError(
          "invalid-metadata",
          "Skill `metadata` must be a mapping of string keys to string values."
        )
      ]
    };
  }
  const metadata: Record<string, string> = {};
  let problem: SkillParseError | undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      problem ??= new SkillParseError(
        "invalid-metadata",
        `Skill \`metadata.${key}\` must be a string.`
      );
      continue;
    }
    metadata[key] = String(entry);
  }
  return problem
    ? { value: metadata, problems: [problem] }
    : { value: metadata };
}

/**
 * The spec defines `allowed-tools` as a space-separated string. A YAML list
 * of strings is also accepted, since some clients write it that way.
 */
function parseAllowedTools(value: unknown): Field<readonly string[]> {
  if (value === undefined || value === null) return { value: [] };
  if (typeof value === "string") {
    return { value: value.split(/\s+/).filter((tool) => tool.length > 0) };
  }
  if (
    Array.isArray(value) &&
    value.every((tool): tool is string => typeof tool === "string")
  ) {
    return { value: value.map((tool) => tool.trim()).filter(Boolean) };
  }
  return {
    value: [],
    problems: [
      new SkillParseError(
        "invalid-allowed-tools",
        "Skill `allowed-tools` must be a space-separated string."
      )
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
