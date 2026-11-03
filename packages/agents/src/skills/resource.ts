import { err, ok, type SkillResult } from "./result";

declare const skillResourcePathBrand: unique symbol;

/**
 * A normalized path to a file inside a skill directory, relative to the
 * skill root (for example `references/style-guide.md`). Construct one with
 * {@link parseSkillResourcePath}.
 */
export type SkillResourcePath = string & {
  readonly [skillResourcePathBrand]: true;
};

/**
 * What a skill file is for, from the spec's directory conventions:
 * `scripts/`, `references/`, and `assets/`. Anything else is a `file`.
 */
export type SkillResourceKind = "script" | "reference" | "asset" | "file";

/** A file bundled with a skill, without its content. */
export interface SkillResourceInfo {
  /** Path relative to the skill directory. */
  readonly path: SkillResourcePath;
  /** Role inferred from the top-level directory. */
  readonly kind: SkillResourceKind;
  /** How {@link SkillResource.content} is encoded. */
  readonly encoding: "text" | "base64";
  /** MIME type, when the extension maps to a known one. */
  readonly mimeType?: string;
  /** Size in bytes, when the source knows it without reading the file. */
  readonly size?: number;
}

/** A file bundled with a skill, with its content. */
export interface SkillResource extends SkillResourceInfo {
  /** UTF-8 text, or base64 for binary files. */
  readonly content: string;
}

/** A resource path that is absolute, escapes the skill, or is malformed. */
export class InvalidSkillResourcePathError extends Error {
  /** Stable tag for narrowing. */
  readonly _tag = "InvalidSkillResourcePathError" as const;

  /** @param path - The rejected path. */
  constructor(readonly path: string) {
    super(
      `Skill resource path must be a normalized relative path inside the skill: ${path}`
    );
    this.name = "InvalidSkillResourcePathError";
  }
}

/**
 * Parse a path to a file inside a skill directory.
 *
 * @param path - Candidate path relative to the skill root.
 * @returns The branded path, or `InvalidSkillResourcePathError` when it is
 * empty, absolute, contains `.`/`..`/empty segments or NUL, or names
 * `SKILL.md` itself.
 */
export function parseSkillResourcePath(
  path: string
): SkillResult<SkillResourcePath, InvalidSkillResourcePathError> {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path === "SKILL.md" ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return err(new InvalidSkillResourcePathError(path));
  }
  // SAFETY: every rule the SkillResourcePath brand promises was checked above.
  return ok(path as SkillResourcePath);
}

const TEXT_EXTENSIONS = new Set([
  "",
  ".bash",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const MIME_TYPES = new Map([
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".py", "text/x-python"],
  [".sh", "text/x-shellscript"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"]
]);

/** Directories and files never treated as skill resources. */
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".DS_Store"]);

/** @internal Lowercased extension including the dot, or `""`. */
export function extensionOf(path: string): string {
  const file = path.split("/").at(-1) ?? path;
  const index = file.lastIndexOf(".");
  return index <= 0 ? "" : file.slice(index).toLowerCase();
}

/** @internal Whether a skill-relative path is tooling noise, not content. */
export function isIgnoredSkillPath(path: string): boolean {
  return path.split("/").some((part) => IGNORED_SEGMENTS.has(part));
}

/** @internal Describe a resource from its path alone. */
export function describeSkillResource(
  path: SkillResourcePath,
  size?: number
): SkillResourceInfo {
  const root = path.split("/", 1)[0];
  const kind: SkillResourceKind =
    root === "scripts"
      ? "script"
      : root === "references"
        ? "reference"
        : root === "assets"
          ? "asset"
          : "file";
  const extension = extensionOf(path);
  const mimeType = MIME_TYPES.get(extension);
  return {
    path,
    kind,
    encoding: TEXT_EXTENSIONS.has(extension) ? "text" : "base64",
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(size === undefined ? {} : { size })
  };
}

/** @internal Encode file bytes the way {@link SkillResource} expects. */
export function encodeSkillResourceContent(
  bytes: Uint8Array,
  encoding: "text" | "base64"
): string {
  if (encoding === "text") return new TextDecoder().decode(bytes);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}
