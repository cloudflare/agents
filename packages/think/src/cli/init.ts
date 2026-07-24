import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fileExists,
  gitOutcomeMessage,
  initCommand as scaffoldFromTemplate,
  initializeGit,
  looksLikeThinkApp,
  packageName,
  readTextIfExists,
  runNpmInstall,
  type GitInitOutcome,
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
  const gitOutcome = await initializeGit(root, {
    gitRunner: options.gitRunner,
    isInsideGitRepo: options.isInsideGitRepo
  });

  if (options.install ?? true) {
    await (options.installRunner ?? runNpmInstall)(root);
  }

  printSuccess(plan, skipped, options.install ?? true, gitOutcome);
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
        path: ".gitignore",
        content: gitignore()
      },
      {
        path: ".oxlintrc.json",
        content: oxlintConfig()
      },
      {
        path: ".oxfmtrc.json",
        content: oxfmtConfig()
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
    "Would initialize a git repository (skipped if already inside one).",
    install ? "Would run: npm install" : "Would skip dependency install."
  );
  console.log(lines.join("\n"));
}

function printSuccess(
  plan: InitPlan,
  skipped: Set<string>,
  install: boolean,
  gitOutcome: GitInitOutcome
): void {
  const lines = [
    `Added Think to ${plan.root}.`,
    gitOutcomeMessage(gitOutcome),
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
// `workers-ai-provider` is intentionally NOT listed here: `@cloudflare/think`
// depends on it directly and resolves string models through it, so scaffolded
// projects get it transitively. Add it explicitly only if you import
// `createWorkersAI` yourself.
export const THIRD_PARTY_DEPENDENCIES: Record<string, string> = {
  ai: "^6.0.202"
};

export const THIRD_PARTY_DEV_DEPENDENCIES: Record<string, string> = {
  "@cloudflare/vite-plugin": "^1.42.3",
  "@cloudflare/workers-types": "^4.20260629.1",
  oxfmt: "^0.56.0",
  oxlint: "^1.71.0",
  typescript: "^6.0.3",
  vite: "^8.1.0",
  wrangler: "^4.105.0"
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
        types: "think types --all",
        format: "oxfmt --write .",
        "format:check": "oxfmt --check .",
        lint: "oxlint .",
        typecheck: "tsc --noEmit",
        check: "npm run format:check && npm run lint && npm run typecheck"
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
    `import bundledSkills from "agents:skills";`,
    "",
    "export class Assistant extends Think<Env> {",
    "  override getModel() {",
    "    // Resolved via the built-in workers-ai-provider off env.AI. Use a",
    '    // "@cf/..." id for Workers AI, or a "provider/model" slug like',
    '    // "openai/gpt-5.5" to route through AI Gateway.',
    '    return "@cf/moonshotai/kimi-k2.7-code";',
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

// Kept in sync with `think-starters/basic/.gitignore` (the canonical starter
// ignore file) so scaffolded and augmented projects ignore the same set.
function gitignore(): string {
  return `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*

# Diagnostic reports (https://nodejs.org/api/report.html)
report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json

# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Directory for instrumented libs generated by jscoverage/JSCover
lib-cov

# Coverage directory used by tools like istanbul
coverage
*.lcov

# nyc test coverage
.nyc_output

# Grunt intermediate storage (https://gruntjs.com/creating-plugins#storing-task-files)
.grunt

# Bower dependency directory (https://bower.io/)
bower_components

# node-waf configuration
.lock-wscript

# Compiled binary addons (https://nodejs.org/api/addons.html)
build/Release

# Dependency directories
node_modules/
jspm_packages/

# Snowpack dependency directory (https://snowpack.dev/)
web_modules/

# TypeScript cache
*.tsbuildinfo

# Optional npm cache directory
.npm

# Optional eslint cache
.eslintcache

# Optional stylelint cache
.stylelintcache

# Optional REPL history
.node_repl_history

# Output of 'npm pack'
*.tgz

# Yarn Integrity file
.yarn-integrity

# dotenv environment variable files
.env
.env.*
!.env.example

# parcel-bundler cache (https://parceljs.org/)
.cache
.parcel-cache

# Next.js build output
.next
out

# Nuxt.js build / generate output
.nuxt
dist
.output

# Gatsby files
.cache/
# Comment in the public line in if your project uses Gatsby and not Next.js
# https://nextjs.org/blog/next-9-1#public-directory-support
# public

# vuepress build output
.vuepress/dist

# vuepress v2.x temp directory
.temp

# Sveltekit cache directory
.svelte-kit/

# vitepress build output
**/.vitepress/dist

# vitepress cache directory
**/.vitepress/cache

# Docusaurus cache and generated files
.docusaurus

# Serverless directories
.serverless/

# FuseBox cache
.fusebox/

# DynamoDB Local files
.dynamodb/

# Firebase cache directory
.firebase/

# TernJS port file
.tern-port

# Stores VSCode versions used for testing VSCode extensions
.vscode-test

# pnpm
.pnpm-store

# yarn v3
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/sdks
!.yarn/versions

# Vite files
vite.config.js.timestamp-*
vite.config.ts.timestamp-*
.vite/


.wrangler
.dev.vars
.DS_Store
`;
}

function oxlintConfig(): string {
  return `${JSON.stringify(
    {
      $schema: "./node_modules/oxlint/configuration_schema.json",
      plugins: ["react", "jsx-a11y", "typescript"],
      categories: {
        correctness: "error"
      },
      rules: {
        "no-explicit-any": "error",
        "typescript/no-deprecated": "warn",
        "react-hooks/exhaustive-deps": "warn",
        "no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_"
          }
        ]
      },
      ignorePatterns: ["**/env.d.ts", "**/think.d.ts"]
    },
    null,
    2
  )}\n`;
}

function oxfmtConfig(): string {
  return `${JSON.stringify(
    {
      $schema: "./node_modules/oxfmt/configuration_schema.json",
      trailingComma: "none",
      printWidth: 80,
      experimentalSortPackageJson: false,
      ignorePatterns: ["**/think.d.ts"]
    },
    null,
    2
  )}\n`;
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
