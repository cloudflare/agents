import babel from "@rolldown/plugin-babel";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Plugin } from "vite";

const SKILLS_SPECIFIER = "agents:skills";
const SKILLS_VIRTUAL_PREFIX = "\0agents:skills:";
const SKILL_RESOURCE_ROOTS = new Set([
  "references",
  "scripts",
  "assets",
  "graphics",
  "fonts",
  "templates",
  "rendered-files",
  "illustrations"
]);
const SKILL_IGNORED_ROOTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "coverage",
  "node_modules"
]);
const SPEC_RESOURCE_ROOTS = new Set(["references", "scripts", "assets"]);

// Bundled skill resources are base64-embedded into the Worker bundle, which
// inflates them by ~1.33x and competes with app code for the bundle-size
// budget. These heuristic thresholds (raw bytes) trigger a recommendation to
// move large assets to an R2-backed skill source instead.
const SKILL_ASSET_WARN_BYTES = 256 * 1024;
const SKILL_BUNDLE_WARN_BYTES = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

interface SkillFile {
  name: string;
  description: string;
  body: string;
  rawContent: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  resources: Array<{
    path: string;
    kind: "reference" | "script" | "asset" | "file";
    size: number;
    encoding: "text" | "base64";
    mimeType?: string;
    content: string;
  }>;
}

function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const parsed = parseYaml(match[1] ?? "");
  const data =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { data, body: match[2] ?? "" };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resourceKind(path: string): "reference" | "script" | "asset" | "file" {
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("scripts/")) return "script";
  if (
    path.startsWith("assets/") ||
    path.startsWith("graphics/") ||
    path.startsWith("fonts/") ||
    path.startsWith("templates/") ||
    path.startsWith("rendered-files/") ||
    path.startsWith("illustrations/")
  ) {
    return "asset";
  }
  return "file";
}

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const MIME_TYPES = new Map([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".py", "text/x-python"],
  [".sh", "text/x-shellscript"],
  [".svg", "image/svg+xml"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"]
]);

function extensionOf(path: string): string {
  const file = path.split("/").at(-1) ?? path;
  const index = file.lastIndexOf(".");
  return index === -1 ? "" : file.slice(index).toLowerCase();
}

function resourceEncoding(path: string): "text" | "base64" {
  return TEXT_EXTENSIONS.has(extensionOf(path)) ? "text" : "base64";
}

function resourceMimeType(path: string): string | undefined {
  return MIME_TYPES.get(extensionOf(path));
}

async function collectFiles(
  root: string,
  relativeRoot = "",
  warn?: (message: string) => void
): Promise<Array<{ path: string; absolutePath: string; size: number }>> {
  const entries = await readdir(join(root, relativeRoot), {
    withFileTypes: true
  }).catch(() => []);
  const files: Array<{ path: string; absolutePath: string; size: number }> = [];

  for (const entry of entries) {
    if (SKILL_IGNORED_ROOTS.has(entry.name)) continue;
    const relativePath = relativeRoot
      ? `${relativeRoot}/${entry.name}`
      : entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      const resourceRoot = relativePath.split("/")[0];
      if (!resourceRoot || SKILL_IGNORED_ROOTS.has(resourceRoot)) continue;
      if (!SKILL_RESOURCE_ROOTS.has(resourceRoot)) {
        if (!relativeRoot) {
          warn?.(
            `Ignoring skill directory "${relativePath}". Bundled skill resources should live under references/, scripts/, assets/, or a known asset root.`
          );
        }
        continue;
      }
      if (!SPEC_RESOURCE_ROOTS.has(resourceRoot) && !relativeRoot) {
        warn?.(
          `Bundling non-standard skill resource root "${resourceRoot}/". Prefer assets/ for portable Agent Skills when possible.`
        );
      }
      files.push(...(await collectFiles(root, relativePath, warn)));
    } else if (entry.isFile() && relativePath !== "SKILL.md") {
      const resourceRoot = relativePath.split("/")[0];
      if (!resourceRoot || SKILL_IGNORED_ROOTS.has(resourceRoot)) continue;
      if (!SKILL_RESOURCE_ROOTS.has(resourceRoot)) {
        warn?.(
          `Ignoring skill file "${relativePath}". Bundled skill resources should live under references/, scripts/, assets/, or a known asset root.`
        );
        continue;
      }
      const info = await stat(absolutePath);
      files.push({ path: relativePath, absolutePath, size: info.size });
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectWatchTargets(
  root: string,
  relativeRoot = ""
): Promise<string[]> {
  const directory = join(root, relativeRoot);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => []
  );
  const targets = [directory];

  for (const entry of entries) {
    if (SKILL_IGNORED_ROOTS.has(entry.name)) continue;
    const relativePath = relativeRoot
      ? `${relativeRoot}/${entry.name}`
      : entry.name;
    const resourceRoot = relativePath.split("/")[0];
    if (!resourceRoot || SKILL_IGNORED_ROOTS.has(resourceRoot)) continue;

    const absolutePath = join(root, relativePath);
    targets.push(absolutePath);

    if (entry.isDirectory()) {
      targets.push(...(await collectWatchTargets(root, relativePath)));
    }
  }

  return targets;
}

async function readSkill(
  skillDir: string,
  warn?: (message: string) => void
): Promise<SkillFile | null> {
  const skillPath = join(skillDir, "SKILL.md");
  const rawContent = await readFile(skillPath, "utf8").catch(() => null);
  if (rawContent === null) return null;

  const { data, body } = parseFrontmatter(rawContent);
  const name = stringField(data.name);
  const description = stringField(data.description);
  if (!name || !description) return null;

  const resources = await Promise.all(
    (await collectFiles(skillDir, "", warn)).map(async (file) => {
      const encoding = resourceEncoding(file.path);
      const bytes = await readFile(file.absolutePath);
      return {
        path: file.path,
        kind: resourceKind(file.path),
        size: file.size,
        encoding,
        mimeType: resourceMimeType(file.path),
        content:
          encoding === "base64" ? bytes.toString("base64") : bytes.toString()
      };
    })
  );

  return {
    name,
    description,
    body,
    rawContent,
    compatibility: stringField(data.compatibility),
    license: stringField(data.license),
    allowedTools: stringField(data["allowed-tools"]),
    metadata: recordField(data.metadata),
    resources
  };
}

async function buildSkillsModule(
  dir: string,
  warn?: (message: string) => void
): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: SkillFile[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await readSkill(join(dir, entry.name), warn);
    if (!skill) continue;
    if (seen.has(skill.name)) {
      warn?.(
        `Duplicate bundled skill name "${skill.name}" in "${entry.name}/"; keeping the first occurrence and ignoring this one.`
      );
      continue;
    }
    seen.add(skill.name);
    skills.push(skill);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  let totalBytes = 0;
  for (const skill of skills) {
    for (const resource of skill.resources) {
      totalBytes += resource.size;
      if (resource.size > SKILL_ASSET_WARN_BYTES) {
        warn?.(
          `Bundled skill resource "${skill.name}/${resource.path}" is ${formatBytes(resource.size)}; large assets bloat the Worker bundle (base64, ~1.33x). Prefer an R2-backed source via skills.r2().`
        );
      }
    }
  }
  if (totalBytes > SKILL_BUNDLE_WARN_BYTES) {
    warn?.(
      `Bundled skills total ${formatBytes(totalBytes)} of embedded resources; this competes with the Worker bundle-size budget. Consider serving large skills from R2 via skills.r2().`
    );
  }

  const hash = createHash("sha256");
  hash.update(JSON.stringify(skills));

  const manifest = {
    id: `bundle:${basename(dir)}`,
    fingerprint: hash.digest("hex"),
    skills
  };

  return `const manifest = ${JSON.stringify(manifest)};\nexport default {\n  id: manifest.id,\n  fingerprint: manifest.fingerprint,\n  async list() {\n    return manifest.skills.map(({ body, rawContent, resources, ...skill }) => skill);\n  },\n  async load(name) {\n    const skill = manifest.skills.find((entry) => entry.name === name);\n    if (!skill) return null;\n    return {\n      ...skill,\n      resources: skill.resources.map(({ content, ...resource }) => resource)\n    };\n  },\n  async readResource(name, path) {\n    const skill = manifest.skills.find((entry) => entry.name === name);\n    const resource = skill?.resources.find((entry) => entry.path === path);\n    return resource ? { ...resource } : null;\n  }\n};\n`;
}

const TURNDOWN_STUB_ID = "\0agents:turndown-stub";

// `just-bash` (pulled in by the workspace bash tool / skill runner) statically
// depends on `turndown`, whose ESM build runs a top-level `require()` on its
// Node DOM fallback. Workers is ESM with no global `require`, so the module
// throws at startup — even when the bash tool is never used. turndown is only
// needed by just-bash's niche `html-to-markdown` command, so we replace it with
// an inert stub by default to keep Workers deploys clean. Opt out with
// `agents({ stubTurndown: false })` if you rely on turndown elsewhere.
function turndownStubPlugin(): Plugin {
  return {
    name: "agents-turndown-stub",
    enforce: "pre",
    resolveId(source) {
      if (source === "turndown") return TURNDOWN_STUB_ID;
      return null;
    },
    load(id) {
      if (id !== TURNDOWN_STUB_ID) return null;
      return `class TurndownService {
  constructor() {}
  use() { return this; }
  addRule() { return this; }
  keep() { return this; }
  remove() { return this; }
  turndown() { return ""; }
}
export default TurndownService;
`;
    }
  };
}

function skillsImportPlugin(): Plugin {
  return {
    name: "agents-skills-import",
    async resolveId(source, importer) {
      // `agents:skills` resolves to a `./skills` directory next to the
      // importer; `agents:skills/<dir>` points at a sibling directory.
      if (
        source !== SKILLS_SPECIFIER &&
        !source.startsWith(`${SKILLS_SPECIFIER}/`)
      ) {
        return null;
      }
      if (!importer) return null;
      const relative =
        source === SKILLS_SPECIFIER
          ? "skills"
          : source.slice(SKILLS_SPECIFIER.length + 1);
      const resolved = resolve(importer, "..", relative);
      return `${SKILLS_VIRTUAL_PREFIX}${resolved}`;
    },
    async load(id) {
      if (!id.startsWith(SKILLS_VIRTUAL_PREFIX)) return null;
      const dir = id.slice(SKILLS_VIRTUAL_PREFIX.length);
      for (const target of await collectWatchTargets(dir)) {
        this.addWatchFile(target);
      }
      return buildSkillsModule(dir, (message) => this.warn(message));
    }
  };
}

export interface AgentsPluginOptions {
  /**
   * Replace `turndown` with an inert stub so `just-bash` (workspace bash tool /
   * skill runner) doesn't drag turndown's `require()`-using DOM fallback into
   * the Worker's module-init path and break deploys. Enabled by default. Set to
   * `false` if your app uses turndown directly and needs the real
   * implementation.
   */
  stubTurndown?: boolean;
}

/**
 * Vite plugin for Agents SDK projects.
 *
 * Handles TC39 decorator transforms (Oxc doesn't support them yet, oxc#9170) so
 * `@callable()` works at runtime, the `agents:skills` import transform, and
 * stubbing `turndown` to keep Workers deploys clean. Will grow to cover other
 * Agents-specific build concerns as needed.
 */
export default function agents(options: AgentsPluginOptions = {}): Plugin[] {
  const { stubTurndown = true } = options;
  return [
    ...(stubTurndown ? [turndownStubPlugin()] : []),
    skillsImportPlugin(),
    babel({
      presets: [
        {
          preset: () => ({
            plugins: [
              ["@babel/plugin-proposal-decorators", { version: "2023-11" }]
            ]
          }),
          rolldown: { filter: { code: "@" } }
        }
      ]
    }) as unknown as Plugin
  ];
}
