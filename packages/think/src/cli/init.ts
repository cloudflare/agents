import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  initCommand as scaffoldFromTemplate,
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

  await assertNoUserFileConflicts(plan);

  if (options.dryRun) {
    printDryRun(plan, options.install ?? true);
    return;
  }

  await writePlannedFiles(plan);

  if (options.install ?? true) {
    await (options.installRunner ?? runNpmInstall)(root);
  }

  printSuccess(plan, options.install ?? true);
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

async function assertNoUserFileConflicts(plan: InitPlan): Promise<void> {
  const conflicts: string[] = [];
  for (const file of plan.files) {
    const absolute = path.join(plan.root, file.path);
    if (!(await fileExists(absolute))) continue;
    if (file.merge === "package-json") continue;
    conflicts.push(file.path);
  }
  if (conflicts.length > 0) {
    throw new Error(
      [
        "Refusing to overwrite existing user-owned files:",
        ...conflicts.map((file) => `- ${file}`)
      ].join("\n")
    );
  }
}

async function writePlannedFiles(plan: InitPlan): Promise<void> {
  await mkdir(plan.root, { recursive: true });
  for (const file of plan.files) {
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

async function looksLikeThinkApp(root: string): Promise<boolean> {
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

function printDryRun(plan: InitPlan, install: boolean): void {
  console.log(
    [
      "Think init would add to the current project:",
      ...plan.files.map((file) => `- ${file.path}`),
      install ? "Would run: npm install" : "Would skip dependency install."
    ].join("\n")
  );
}

function printSuccess(plan: InitPlan, install: boolean): void {
  console.log(
    [
      `Added Think to ${plan.root}.`,
      install ? "Installed npm dependencies." : "Skipped npm install.",
      "",
      "Next steps:",
      "- Edit agents/assistant/agent.ts to customize the model, prompt, skills, and schedules",
      "- npm run dev",
      "- npm run types",
      "- npm run deploy"
    ].join("\n")
  );
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
        "@cloudflare/think": "latest",
        agents: "latest",
        ai: "latest",
        "workers-ai-provider": "latest"
      },
      devDependencies: {
        "@cloudflare/vite-plugin": "latest",
        "@cloudflare/workers-types": "latest",
        typescript: "latest",
        vite: "latest",
        wrangler: "latest"
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
    '      "@cf/moonshotai/kimi-k2.6",',
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
