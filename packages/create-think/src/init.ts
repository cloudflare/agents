import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import tiged from "tiged";
import {
  copyLocalTemplate,
  DEFAULT_TEMPLATE_REF,
  finalizeTemplate,
  findLocalTemplatesRoot,
  localTemplateExists,
  resolveTemplateName,
  THINK_TEMPLATES_REPO,
  type TemplateFetcher
} from "./templates";

export interface InitCommandOptions {
  root?: string;
  directory?: string;
  name?: string;
  /** Starter template to scaffold. Defaults to `basic`. */
  template?: string;
  /** Git ref passed to the remote template fetcher. Defaults to `main`. */
  ref?: string;
  yes?: boolean;
  install?: boolean;
  dryRun?: boolean;
  /** Local templates directory override (used in-repo and by tests). */
  templatesDir?: string;
  /**
   * Fetches a template from a remote source. Defaults to a degit (tiged) fetch
   * from the agents repo; injectable for tests.
   */
  fetchTemplate?: TemplateFetcher;
  promptTargetDirectory?: (defaultDirectory: string) => Promise<string>;
  installRunner?: (root: string) => Promise<void>;
}

const SAFE_EMPTY_DIRECTORY_ENTRIES = new Set([".git", ".DS_Store"]);
const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs"
];

const ADJECTIVES = [
  "bright",
  "calm",
  "clever",
  "gentle",
  "quiet",
  "rapid",
  "steady",
  "sunny"
];

const NOUNS = [
  "agent",
  "brook",
  "comet",
  "harbor",
  "meadow",
  "river",
  "signal",
  "spark"
];

/**
 * Default remote template fetcher. Pulls a starter folder out of the agents
 * repo with degit (tiged).
 */
const tigedFetchTemplate: TemplateFetcher = async ({ template, ref, dest }) => {
  const source = `${THINK_TEMPLATES_REPO}/${template}#${ref}`;
  const emitter = tiged(source, { disableCache: true, mode: "tar" });
  await emitter.clone(dest);
};

export async function initCommand(options: InitCommandOptions): Promise<void> {
  const baseRoot = path.resolve(options.root ?? process.cwd());
  const template = resolveTemplateName(options.template);
  const selectedDirectory = await selectTargetDirectory(options, baseRoot);
  const targetRoot = resolveTargetRoot(baseRoot, selectedDirectory);
  const projectName = packageName(options.name ?? path.basename(targetRoot));

  const existingThinkApp = await looksLikeThinkApp(targetRoot);
  if (existingThinkApp) {
    console.log(
      [
        "This already looks like a Think app.",
        "Try `think inspect` to review the manifest or `think types` to refresh generated declarations."
      ].join("\n")
    );
    return;
  }

  await assertSafeTargetDirectory(targetRoot, selectedDirectory);

  if (options.dryRun) {
    console.log(
      [
        `Think init would create a "${template}" app in ${targetRoot}.`,
        (options.install ?? true)
          ? "Would run: npm install"
          : "Would skip dependency install."
      ].join("\n")
    );
    return;
  }

  await mkdir(targetRoot, { recursive: true });
  await fetchTemplate(template, targetRoot, options);
  await finalizeTemplate(targetRoot, projectName);

  if (options.install ?? true) {
    await (options.installRunner ?? runNpmInstall)(targetRoot);
  }

  printSuccess(
    targetRoot,
    selectedDirectory,
    template,
    options.install ?? true
  );
}

async function fetchTemplate(
  template: string,
  targetRoot: string,
  options: InitCommandOptions
): Promise<void> {
  const localRoot =
    options.templatesDir ?? (await findLocalTemplatesRoot(template));
  if (localRoot && (await localTemplateExists(localRoot, template))) {
    await copyLocalTemplate(path.join(localRoot, template), targetRoot);
    return;
  }
  const fetch = options.fetchTemplate ?? tigedFetchTemplate;
  await fetch({
    template,
    ref: options.ref ?? DEFAULT_TEMPLATE_REF,
    dest: targetRoot
  });
}

async function selectTargetDirectory(
  options: InitCommandOptions,
  root: string
): Promise<string> {
  if (options.directory) return normalizeTargetDirectory(options.directory);
  const randomDirectory = await uniqueDefaultDirectory(root);
  // `--yes` always scaffolds into a fresh subfolder so non-interactive runs
  // (e.g. `npm create think -y`) never write into an unexpected directory.
  if (options.yes) return randomDirectory;
  // Interactively, an empty starting folder is almost always meant to *be* the
  // app, so offer `.` as the default; otherwise suggest a new subfolder.
  const defaultDirectory = (await isSafeEmptyDirectory(root))
    ? "."
    : randomDirectory;
  const target = await (options.promptTargetDirectory ?? promptTargetDirectory)(
    defaultDirectory
  );
  return normalizeTargetDirectory(target || defaultDirectory);
}

async function isSafeEmptyDirectory(root: string): Promise<boolean> {
  const entries = await readDirectoryEntries(root);
  return entries.every((entry) => SAFE_EMPTY_DIRECTORY_ENTRIES.has(entry));
}

async function promptTargetDirectory(
  defaultDirectory: string
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(
      `Where should Think create your app? (${defaultDirectory}) `
    );
  } finally {
    rl.close();
  }
}

async function uniqueDefaultDirectory(root: string): Promise<string> {
  for (let index = 0; index < 24; index++) {
    const candidate = randomProjectDirectory();
    if (!(await fileExists(path.join(root, candidate)))) return candidate;
  }
  return `think-agent-${Date.now().toString(36)}`;
}

function randomProjectDirectory(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `think-agent-${adjective}-${noun}`;
}

function normalizeTargetDirectory(directory: string): string {
  const normalized = directory.trim();
  if (!normalized) throw new Error("Target directory cannot be empty.");
  if (path.isAbsolute(normalized)) {
    throw new Error("Target directory must be relative to the project root.");
  }
  return normalized;
}

function resolveTargetRoot(
  baseRoot: string,
  selectedDirectory: string
): string {
  const targetRoot = path.resolve(baseRoot, selectedDirectory);
  const relative = path.relative(baseRoot, targetRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Target directory must stay inside the project root.");
  }
  return targetRoot;
}

async function assertSafeTargetDirectory(
  root: string,
  selectedDirectory: string
): Promise<void> {
  const entries = await readDirectoryEntries(root);
  if (entries.length === 0) return;
  if (
    selectedDirectory === "." &&
    entries.every((entry) => SAFE_EMPTY_DIRECTORY_ENTRIES.has(entry))
  ) {
    return;
  }
  throw new Error(
    "Target directory is not empty. Choose a new or empty folder for the new Think app."
  );
}

export async function looksLikeThinkApp(root: string): Promise<boolean> {
  let hasThinkDependency = false;
  const packageSource = await readTextIfExists(path.join(root, "package.json"));
  if (packageSource) {
    try {
      const packageJson = JSON.parse(packageSource) as PackageJson;
      hasThinkDependency = Boolean(
        packageJson.dependencies?.["@cloudflare/think"] ||
        packageJson.devDependencies?.["@cloudflare/think"]
      );
    } catch {
      hasThinkDependency = false;
    }
  }
  const viteConfig = await readFirstExistingText(
    VITE_CONFIG_FILES.map((file) => path.join(root, file))
  );
  if (viteConfig?.includes("@cloudflare/think/vite")) return true;
  const wranglerConfig = await readFirstExistingText(
    ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map((file) =>
      path.join(root, file)
    )
  );
  if (wranglerConfig?.includes("virtual:think/entry")) return true;
  return hasThinkDependency && (await fileExists(path.join(root, "agents")));
}

function printSuccess(
  root: string,
  selectedDirectory: string,
  template: string,
  install: boolean
): void {
  const lines = [
    `Created a "${template}" Think app in ${root}.`,
    install ? "Installed npm dependencies." : "Skipped npm install.",
    "",
    "Next steps:"
  ];
  if (selectedDirectory !== ".") {
    lines.push(`- cd ${selectedDirectory}`);
  }
  lines.push(
    "- Edit the agent in agents/ to customize the model, prompt, tools, and skills",
    "- npm run dev",
    "- npm run types",
    "- npm run deploy"
  );
  console.log(lines.join("\n"));
}

async function runNpmInstall(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd: root,
      stdio: "inherit",
      // On Windows `npm` resolves to `npm.cmd`, which Node's spawn won't find
      // without a shell.
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`npm install failed with exit code ${code ?? "unknown"}.`)
      );
    });
  });
}

function packageName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[._]+/, "") || "think-agent"
  );
}

async function readDirectoryEntries(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readFirstExistingText(files: string[]): Promise<string | null> {
  for (const file of files) {
    const source = await readTextIfExists(file);
    if (source !== null) return source;
  }
  return null;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

interface PackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}
