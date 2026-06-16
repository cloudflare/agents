import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  initCommand as scaffoldFromTemplate,
  looksLikeThinkApp,
  type InitCommandOptions as TemplateInitOptions
} from "create-think";
import { createThinkWorkerConfig } from "../framework/config";
import { discoverThinkApp } from "../framework/discovery";
import { generateThinkTypes } from "../framework/types-codegen";

export interface InitCommandOptions extends TemplateInitOptions {
  /** Think route prefix, used when augmenting an existing project. */
  routePrefix?: string;
}

interface PlannedFile {
  path: string;
  content: string;
  merge?: "package-json";
}

interface InitPlan {
  root: string;
  projectName: string;
  files: PlannedFile[];
  packageJsonPath: string;
}

const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs"
];

/**
 * `think init` has two modes:
 *
 * - New project: when a `--template` is given, or when the command is run
 *   outside an existing npm project. Delegates to `create-think`, which fetches
 *   a complete starter template (no framework dependency required at runtime).
 * - Augment in place: when run inside an existing npm project with no
 *   `--template`. Adds Think framework files (agent, Vite/Wrangler config,
 *   generated types) and merges dependencies into the current project.
 */
export async function initCommand(options: InitCommandOptions): Promise<void> {
  const baseRoot = path.resolve(options.root ?? process.cwd());
  const insideExistingProject =
    !options.directory &&
    (await fileExists(path.join(baseRoot, "package.json")));
  const useTemplate = Boolean(options.template) || !insideExistingProject;

  if (useTemplate) {
    await scaffoldFromTemplate(options);
    return;
  }

  await augmentExistingProject(baseRoot, options);
}

async function augmentExistingProject(
  root: string,
  options: InitCommandOptions
): Promise<void> {
  const projectName = packageName(options.name ?? path.basename(root));

  if (await looksLikeThinkApp(root)) {
    console.log(
      [
        "This already looks like a Think app.",
        "Try `think inspect` to review the manifest or `think types` to refresh generated declarations."
      ].join("\n")
    );
    return;
  }

  const migrationReason = await unsafeMigrationReason(root);
  if (migrationReason) {
    throw new Error(
      [
        "This directory already has Vite or Wrangler configuration, so `think init` will not migrate it automatically yet.",
        migrationReason,
        "Start a new Think app with `npm create think`, or add `@cloudflare/think/vite` and Think framework files manually."
      ].join("\n")
    );
  }

  const plan = await createInitPlan({
    root,
    projectName,
    routePrefix: options.routePrefix
  });

  // Anything the user already owns (e.g. an existing tsconfig.json) is kept as-is
  // rather than aborting the whole command. Vite/Wrangler config is handled by
  // the migration guard above, so the rest is safe to skip and report.
  const skipped = await existingPlanFiles(plan);

  if (options.dryRun) {
    printDryRun(plan, skipped, options.install ?? true);
    return;
  }

  await writePlannedFiles(plan, skipped);

  if (options.install ?? true) {
    await (options.installRunner ?? runNpmInstall)(root);
  }

  printSuccess(plan, skipped, options.install ?? true);
}

async function createInitPlan(options: {
  root: string;
  projectName: string;
  routePrefix?: string;
}): Promise<InitPlan> {
  const sourceFiles = {
    "agents/assistant/agent.ts": agentSource(),
    "agents/assistant/skills/project-helper/SKILL.md": starterSkillSource()
  };
  const manifest = discoverThinkApp({
    root: options.root,
    routePrefix: options.routePrefix,
    files: sourceFiles
  });
  const workerConfig = createThinkWorkerConfig(manifest, {
    name: options.projectName,
    routePrefix: options.routePrefix
  });
  workerConfig.ai = { binding: "AI" };
  workerConfig.worker_loaders = [{ binding: "LOADER" }];
  const typeFiles = generateThinkTypes(manifest, {
    files: sourceFiles,
    typesFile: "think.d.ts"
  });

  return {
    root: options.root,
    projectName: options.projectName,
    packageJsonPath: "package.json",
    files: [
      {
        path: "package.json",
        content: packageJsonSource(options.projectName),
        merge: "package-json"
      },
      {
        path: "vite.config.ts",
        content: viteConfig(options.routePrefix)
      },
      {
        path: "wrangler.jsonc",
        content: `${JSON.stringify(workerConfig, null, 2)}\n`
      },
      {
        path: "tsconfig.json",
        content: tsconfig()
      },
      {
        path: "agents/assistant/agent.ts",
        content: sourceFiles["agents/assistant/agent.ts"]
      },
      {
        path: "agents/assistant/skills/project-helper/SKILL.md",
        content: sourceFiles["agents/assistant/skills/project-helper/SKILL.md"]
      },
      ...typeFiles
    ]
  };
}

async function existingPlanFiles(plan: InitPlan): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const file of plan.files) {
    // package.json is always merged, never overwritten, so it is never skipped.
    if (file.merge === "package-json") continue;
    if (await fileExists(path.join(plan.root, file.path))) {
      existing.add(file.path);
    }
  }
  return existing;
}

async function writePlannedFiles(
  plan: InitPlan,
  skip: Set<string>
): Promise<void> {
  await mkdir(plan.root, { recursive: true });
  for (const file of plan.files) {
    if (skip.has(file.path)) continue;
    const absolute = path.join(plan.root, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    const content =
      file.merge === "package-json"
        ? await mergePackageJson(absolute, file.content)
        : file.content;
    await writeFile(absolute, content, "utf8");
  }
}

async function mergePackageJson(
  absolutePath: string,
  generatedContent: string
): Promise<string> {
  const generated = JSON.parse(generatedContent) as PackageJson;
  const existingSource = await readTextIfExists(absolutePath);
  if (!existingSource) return generatedContent;
  const existing = JSON.parse(existingSource) as PackageJson;
  return `${JSON.stringify(mergePackageJsonData(existing, generated), null, 2)}\n`;
}

function mergePackageJsonData(
  existing: PackageJson,
  generated: PackageJson
): PackageJson {
  return {
    ...generated,
    ...existing,
    // Think + Vite require ES modules, so the framework's `type` wins even if the
    // existing project was CommonJS (or omitted `type`).
    type: generated.type ?? existing.type,
    scripts: {
      ...generated.scripts,
      ...existing.scripts
    },
    dependencies: {
      ...generated.dependencies,
      ...existing.dependencies
    },
    devDependencies: {
      ...generated.devDependencies,
      ...existing.devDependencies
    }
  };
}

async function unsafeMigrationReason(root: string): Promise<string | null> {
  for (const file of [
    ...VITE_CONFIG_FILES,
    "wrangler.jsonc",
    "wrangler.json",
    "wrangler.toml"
  ]) {
    if (await fileExists(path.join(root, file))) {
      return `Found existing ${file}.`;
    }
  }
  return null;
}

function printDryRun(
  plan: InitPlan,
  skipped: Set<string>,
  install: boolean
): void {
  const lines = [
    "Think init would add to the current project:",
    ...plan.files
      .filter((file) => !skipped.has(file.path))
      .map((file) => `- ${file.path}`)
  ];
  if (skipped.size > 0) {
    lines.push(
      "",
      "Would keep your existing files (left unchanged):",
      ...[...skipped].map((file) => `- ${file}`)
    );
  }
  lines.push(
    install ? "Would run: npm install" : "Would skip dependency install."
  );
  console.log(lines.join("\n"));
}

function printSuccess(
  plan: InitPlan,
  skipped: Set<string>,
  install: boolean
): void {
  const lines = [
    `Added Think to ${plan.root}.`,
    install ? "Installed npm dependencies." : "Skipped npm install."
  ];
  if (skipped.size > 0) {
    lines.push(
      "",
      "Kept your existing files (not overwritten):",
      ...[...skipped].map((file) => `- ${file}`),
      "Reconcile them with Think's expected setup if the app does not build."
    );
  }
  lines.push(
    "",
    "Next steps:",
    "- Edit agents/assistant/agent.ts to customize the model, prompt, skills, and schedules",
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

// In-repo packages float to `latest`: they release in tandem from this
// monorepo via changesets, so a fresh project always gets the newest matching
// set.
const FRAMEWORK_DEPENDENCIES: Record<string, string> = {
  "@cloudflare/think": "latest",
  agents: "latest"
};

// Third-party packages are NOT released in tandem with us, so they are pinned
// to the exact ranges the starter templates are tested against (see
// `think-starters/basic/package.json`). This avoids fresh projects pulling an
// untested major (e.g. a new `vite`/`ai`/`wrangler`). Kept in sync with the
// starter by a test in `src/cli-tests/cli.test.ts`.
export const THIRD_PARTY_DEPENDENCIES: Record<string, string> = {
  ai: "^6.0.202",
  "workers-ai-provider": "^3.2.0"
};

export const THIRD_PARTY_DEV_DEPENDENCIES: Record<string, string> = {
  "@cloudflare/vite-plugin": "^1.40.2",
  "@cloudflare/workers-types": "^4.20260612.1",
  typescript: "^6.0.3",
  vite: "^8.0.16",
  wrangler: "^4.100.0"
};

function packageJsonSource(projectName: string): string {
  return `${JSON.stringify(
    {
      name: projectName,
      private: true,
      type: "module",
      scripts: {
        dev: "vite dev",
        build: "vite build",
        deploy: "vite build && wrangler deploy",
        types: "think types --all"
      },
      dependencies: {
        ...FRAMEWORK_DEPENDENCIES,
        ...THIRD_PARTY_DEPENDENCIES
      },
      devDependencies: {
        ...THIRD_PARTY_DEV_DEPENDENCIES
      }
    },
    null,
    2
  )}\n`;
}

function viteConfig(routePrefix: string | undefined): string {
  const thinkOptions = routePrefix
    ? `({ routePrefix: ${JSON.stringify(routePrefix)} })`
    : "()";
  return [
    `import { cloudflare } from "@cloudflare/vite-plugin";`,
    `import { think } from "@cloudflare/think/vite";`,
    `import { defineConfig } from "vite";`,
    "",
    "export default defineConfig({",
    `  plugins: [think${thinkOptions}, cloudflare()]`,
    "});",
    ""
  ].join("\n");
}

function agentSource(): string {
  return [
    `import { Think, skills } from "@cloudflare/think";`,
    `import { createWorkersAI } from "workers-ai-provider";`,
    `import bundledSkills from "agents:skills";`,
    "",
    "type Env = Cloudflare.Env & {",
    "  AI: Ai;",
    "  LOADER: WorkerLoader;",
    "};",
    "",
    "export class Assistant extends Think<Env> {",
    "  override getModel() {",
    "    return createWorkersAI({ binding: this.env.AI })(",
    '      "@cf/moonshotai/kimi-k2.7-code",',
    "      { sessionAffinity: this.sessionAffinity }",
    "    );",
    "  }",
    "",
    "  override getSystemPrompt() {",
    '    return "You are a helpful assistant. Keep answers clear, practical, and concise.";',
    "  }",
    "",
    "  override getSkills() {",
    "    return [bundledSkills];",
    "  }",
    "",
    "  override getSkillScriptRunner() {",
    "    return skills.runner({",
    "      loader: this.env.LOADER,",
    "      workspaceInstance: this.workspace",
    "    });",
    "  }",
    "}",
    ""
  ].join("\n");
}

function starterSkillSource(): string {
  return [
    "---",
    "name: project-helper",
    "description: Help users plan and explain small project changes. Use when the user asks for implementation guidance, debugging steps, or a concise project plan.",
    "---",
    "",
    "# Project Helper",
    "",
    "Use this skill to give practical, action-oriented project help.",
    "",
    "## Instructions",
    "",
    "1. Restate the user's goal in one sentence.",
    "2. Identify the smallest useful next step.",
    "3. Call out any important risk or missing context.",
    "4. Keep the answer concise and easy to act on.",
    ""
  ].join("\n");
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2021",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
        verbatimModuleSyntax: true,
        types: ["@cloudflare/workers-types"]
      },
      include: ["agents", "think.d.ts", "vite.config.ts"]
    },
    null,
    2
  )}\n`;
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

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
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
