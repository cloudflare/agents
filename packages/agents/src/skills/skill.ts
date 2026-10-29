import { err, ok, type SkillResult } from "./result";

/**
 * The Agent Skills `Skill` type and its frontmatter rules. `SKILL.md`
 * text parsing lives in `./markdown` so code that only handles parsed
 * skills does not load the YAML parser.
 *
 * The rules come from https://agentskills.io/specification. They apply in
 * one of two modes:
 *
 * - `strict` (the default for direct parsing) rejects a skill that breaks
 *   any rule. Use it to check a skill before publishing or writing it.
 * - `lenient` (what skill sources use) follows the spec's guide for agents
 *   that load skills: it loads a skill whose name is too long, badly
 *   formatted, or does not match its directory, and reports each problem
 *   as a warning. A skill with no description, no usable name, or
 *   unreadable frontmatter is still rejected.
 *
 * Frontmatter keys the spec does not define are kept in
 * {@link Skill.extraFields} in both modes.
 *
 * @module
 */

declare const skillNameBrand: unique symbol;

/**
 * A skill name the parser accepted. It is always a single safe path segment
 * (no `/`, `\`, NUL, or control characters, and not `.` or `..`), so it can
 * name a directory, a tool enum value, and a qualified resource path. A name
 * from {@link parseSkillName} or a strict parse also follows the spec format.
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

/**
 * A `SKILL.md` that breaks an Agent Skills rule. Returned as the error of a
 * failed parse, or as a warning when a lenient parse loads the skill anyway.
 */
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

/** How strictly to apply the spec. See the module documentation. */
export type SkillParseMode = "strict" | "lenient";

/** Options for {@link parseSkill}. */
export interface ParseSkillOptions {
  /**
   * Name of the directory that holds this `SKILL.md`. The spec requires the
   * skill's `name` to match it. In lenient mode a missing `name` falls back
   * to the directory.
   */
  readonly directory?: string;
  /** Defaults to `"strict"`. Skill sources parse in `"lenient"` mode. */
  readonly mode?: SkillParseMode;
}

/** The outcome of parsing a skill. */
export type SkillParseResult =
  | {
      readonly ok: true;
      /** The parsed skill. */
      readonly value: Skill;
      /** Rules the skill broke but was loaded anyway. Empty when strict. */
      readonly warnings: readonly SkillParseError[];
    }
  | { readonly ok: false; readonly error: SkillParseError };

const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;
const COMPATIBILITY_MAX_LENGTH = 500;
const NAME_CHARACTERS = /^[\p{L}\p{N}-]+$/u;
// oxlint-disable-next-line no-control-regex -- Rejects control characters in names.
const UNSAFE_NAME_CHARACTERS = /[/\\\u0000-\u001f\u007f]/;
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
  // SAFETY: specNameProblem checked every rule the spec format requires,
  // and the spec format is a subset of the safe-segment rule.
  return ok(name as SkillName);
}

/** A field value, plus the rules it broke when a lenient parse kept it. */
type Field<T> =
  | { readonly value: T; readonly problems?: readonly SkillParseError[] }
  | { readonly fatal: SkillParseError };

/**
 * @internal Build a skill from already-decoded frontmatter. Sources that do
 * not start from a `SKILL.md` string (such as manifests) use this so every
 * skill passes the same rules.
 */
export function parseSkillFrontmatter(
  data: unknown,
  body: string,
  options: ParseSkillOptions = {}
): SkillParseResult {
  if (!isRecord(data)) {
    return err(
      new SkillParseError(
        "invalid-frontmatter",
        "SKILL.md frontmatter must be a YAML mapping."
      )
    );
  }

  const lenient = options.mode === "lenient";
  const warnings: SkillParseError[] = [];
  let failure: SkillParseError | undefined;
  function take<T>(field: Field<T>): T | undefined {
    if ("fatal" in field) {
      failure ??= field.fatal;
      return undefined;
    }
    for (const problem of field.problems ?? []) {
      if (lenient) warnings.push(problem);
      else failure ??= problem;
    }
    return field.value;
  }

  const name = take(parseName(data.name, options.directory, lenient));
  const description = take(parseDescription(data.description));
  const license = take(parseLicense(data.license));
  const compatibility = take(parseCompatibility(data.compatibility));
  const metadata = take(parseMetadata(data.metadata));
  const allowedTools = take(parseAllowedTools(data["allowed-tools"]));
  if (
    failure ||
    name === undefined ||
    description === undefined ||
    metadata === undefined ||
    allowedTools === undefined
  ) {
    return err(
      failure ??
        new SkillParseError("invalid-frontmatter", "Invalid frontmatter.")
    );
  }

  const extraFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SPEC_FIELDS.has(key)) extraFields[key] = value;
  }

  return {
    ok: true,
    value: {
      name,
      description,
      ...(license === undefined ? {} : { license }),
      ...(compatibility === undefined ? {} : { compatibility }),
      metadata,
      allowedTools,
      extraFields,
      body
    },
    warnings
  };
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

/** Whether a name is usable as a directory, enum value, and path segment. */
function isSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !UNSAFE_NAME_CHARACTERS.test(name)
  );
}

function parseName(
  value: unknown,
  directory: string | undefined,
  lenient: boolean
): Field<SkillName> {
  const fallback =
    lenient && (value === undefined || value === null) && directory
      ? directory
      : undefined;
  const declared = typeof value === "string" ? value : fallback;
  if (declared === undefined) {
    return {
      fatal: new SkillParseError(
        "invalid-name",
        "SKILL.md frontmatter must set `name` to a string."
      )
    };
  }
  // Padding is a format problem, not something to fix silently: strict
  // fails on it, lenient trims it and warns.
  const name = declared.trim().normalize("NFKC");
  if (!isSafeName(name)) {
    return {
      fatal: new SkillParseError(
        "invalid-name",
        `Invalid skill name "${declared}": it must be a single path segment without slashes or control characters.`
      )
    };
  }
  // SAFETY: isSafeName checked the guarantees every SkillName carries. Spec
  // format problems are reported below, and a strict parse fails on them.
  const accepted = name as SkillName;

  const problems: SkillParseError[] = [];
  if (fallback) {
    problems.push(
      new SkillParseError(
        "invalid-name",
        `SKILL.md frontmatter has no \`name\`; using its directory "${fallback}".`
      )
    );
  } else {
    const formatProblem =
      declared !== declared.trim()
        ? "it must not start or end with whitespace"
        : specNameProblem(name);
    if (formatProblem !== null) {
      problems.push(
        new SkillParseError(
          "invalid-name",
          `Invalid skill name "${declared}": ${formatProblem}.`
        )
      );
    }
    // Checked independently of the format, so a source reports every rule
    // a name breaks.
    if (directory !== undefined && directory.normalize("NFKC") !== name) {
      problems.push(
        new SkillParseError(
          "name-mismatch",
          `Skill name "${name}" must match its directory "${directory}".`
        )
      );
    }
  }
  return problems.length === 0
    ? { value: accepted }
    : { value: accepted, problems };
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
 * converted to strings rather than rejected. Nested values break the rule;
 * a lenient parse drops them.
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
