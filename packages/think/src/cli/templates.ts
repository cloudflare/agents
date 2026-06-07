import { cp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The starter templates shipped in the repo's top-level `think-starters/`
 * directory. The first entry is the default used when `--template` is omitted.
 */
export const THINK_TEMPLATES = [
  {
    name: "basic",
    description: "Minimal Think chat agent with a small React chat UI."
  },
  {
    name: "personal-assistant",
    description:
      "Assistant with persistent memory (configureSession) and scheduled tasks."
  },
  {
    name: "coding-agent",
    description: "Coding agent with workspace file tools and a coding skill."
  },
  {
    name: "customer-support",
    description: "Support agent with custom tools and an escalation skill."
  }
] as const;

export type ThinkTemplateName = (typeof THINK_TEMPLATES)[number]["name"];

export const DEFAULT_TEMPLATE: ThinkTemplateName = THINK_TEMPLATES[0].name;

/** Files/directories that are never copied from a local workspace template. */
const LOCAL_COPY_IGNORE = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  ".turbo",
  ".dev.vars",
  ".env"
]);

export interface TemplateFetchRequest {
  template: string;
  ref: string;
  dest: string;
}

export type TemplateFetcher = (request: TemplateFetchRequest) => Promise<void>;

export function isKnownTemplate(name: string): name is ThinkTemplateName {
  return THINK_TEMPLATES.some((template) => template.name === name);
}

export function resolveTemplateName(name: string | undefined): string {
  const resolved = (name ?? DEFAULT_TEMPLATE).trim();
  if (!isKnownTemplate(resolved)) {
    throw new Error(
      [
        `Unknown template: ${resolved}`,
        "Available templates:",
        ...THINK_TEMPLATES.map((t) => `- ${t.name} — ${t.description}`)
      ].join("\n")
    );
  }
  return resolved;
}

export function formatTemplateList(): string {
  return THINK_TEMPLATES.map((t) => `- ${t.name} — ${t.description}`).join(
    "\n"
  );
}

/**
 * Locate the in-repo `think-starters/` directory by walking up from this
 * module. Only matches inside the monorepo (identified by a sibling
 * `pnpm-workspace.yaml`), so a published package never accidentally copies
 * from an unrelated `think-starters` folder on the user's machine.
 */
export async function findLocalTemplatesRoot(
  template: string
): Promise<string | null> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "think-starters");
    if (
      (await isDirectory(path.join(dir, ".git"))) ||
      (await fileExists(path.join(dir, "pnpm-workspace.yaml")))
    ) {
      if (await isDirectory(path.join(candidate, template))) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Copy a local template directory into the destination, skipping build
 * artifacts and local secrets.
 */
export async function copyLocalTemplate(
  templateDir: string,
  dest: string
): Promise<void> {
  await cp(templateDir, dest, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !LOCAL_COPY_IGNORE.has(base);
    }
  });
}

/**
 * Wrangler config filenames, in the order `wrangler` itself resolves them.
 */
const WRANGLER_CONFIG_FILES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml"
];

/**
 * After a template is fetched, set the project name (in both `package.json` and
 * the Wrangler config's `name`) and rewrite any `workspace:*` dependencies
 * (used so templates build inside the monorepo) to published version ranges so
 * the project installs standalone.
 */
export async function finalizeTemplate(
  dest: string,
  projectName: string
): Promise<void> {
  await finalizePackageJson(dest, projectName);
  await finalizeWranglerName(dest, projectName);
}

async function finalizePackageJson(
  dest: string,
  projectName: string
): Promise<void> {
  const packageJsonPath = path.join(dest, "package.json");
  const source = await readFile(packageJsonPath, "utf8").catch(() => null);
  if (!source) return;
  const pkg = JSON.parse(source) as Record<string, unknown>;
  pkg.name = projectName;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") {
      rewriteWorkspaceVersions(deps as Record<string, string>);
    }
  }
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * Update the Worker `name` in the template's Wrangler config so each scaffolded
 * app deploys under its own name instead of the shared template name. Done with
 * a targeted replacement of the first `name` field so JSONC comments and
 * formatting are preserved.
 */
async function finalizeWranglerName(
  dest: string,
  projectName: string
): Promise<void> {
  for (const file of WRANGLER_CONFIG_FILES) {
    const configPath = path.join(dest, file);
    const source = await readFile(configPath, "utf8").catch(() => null);
    if (source === null) continue;
    const updated = file.endsWith(".toml")
      ? source.replace(/^(\s*name\s*=\s*")[^"]*(")/m, `$1${projectName}$2`)
      : source.replace(/("name"\s*:\s*")[^"]*(")/, `$1${projectName}$2`);
    if (updated !== source) {
      await writeFile(configPath, updated, "utf8");
    }
    return;
  }
}

function rewriteWorkspaceVersions(deps: Record<string, string>): void {
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      deps[name] = "latest";
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function localTemplateExists(
  root: string,
  template: string
): Promise<boolean> {
  return isDirectory(path.join(root, template));
}
